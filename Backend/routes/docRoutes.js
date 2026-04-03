import express from "express";
import PDFDocument from "pdfkit";
import Document from "../models/Document.js";
import User from "../models/User.js";
import protect from "../middleware/authMiddleware.js";
import {
  getDocumentAccess,
  normalizeLinkAccess,
  normalizeRole,
  serializeDocument,
  serializeVersions,
  snapshotCurrentVersion
} from "../utils/documentAccess.js";

const router = express.Router();

const normalizeEmail = (email) => String(email || "").toLowerCase().trim();
const stripHtml = (content) => String(content || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const sanitizeFilename = (title) => (
  String(title || "document")
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "document"
);

const populateDocument = (query) => query
  .populate("owner", "name email")
  .populate("sharedWith.user", "name email")
  .populate("editRequests.user", "name email");

const findPopulatedDocById = (id) => populateDocument(Document.findById(id));

const getDocListQueryForUser = (user) => ({
  $or: [
    { owner: user.id },
    { "sharedWith.user": user.id },
    { "sharedWith.email": normalizeEmail(user.email) }
  ]
});

const findMatchingShareEntry = (doc, email, userId) => (
  (doc.sharedWith || []).find((entry) => (
    (userId && String(entry.user) === String(userId)) ||
    normalizeEmail(entry.email) === email
  ))
);

router.use(protect);

router.post("/create", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim() || "Untitled Document";
    const content = String(req.body?.content || "");

    const createdDoc = await Document.create({
      title,
      content,
      owner: req.user.id
    });

    const doc = await findPopulatedDocById(createdDoc._id);
    return res.status(201).json(serializeDocument(doc, req.user));
  } catch {
    return res.status(500).json({ message: "Could not create document" });
  }
});

router.get("/", async (req, res) => {
  try {
    const docs = await populateDocument(
      Document.find(getDocListQueryForUser(req.user)).sort({ updatedAt: -1 })
    );

    const serializedDocs = docs.map((doc) => {
      const serialized = serializeDocument(doc, req.user);
      return {
        ...serialized,
        preview: stripHtml(serialized.content || "").slice(0, 120)
      };
    });

    return res.json(serializedDocs);
  } catch {
    return res.status(500).json({ message: "Could not fetch documents" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const doc = await findPopulatedDocById(req.params.id);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.canView) {
      return res.status(403).json({
        message: "No access to this document",
        doc: serializeDocument(doc, req.user, { redactForNoView: true })
      });
    }

    return res.json(serializeDocument(doc, req.user));
  } catch {
    return res.status(500).json({ message: "Could not fetch document" });
  }
});

router.get("/:id/export/pdf", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).populate("owner", "name email");

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.canView) {
      return res.status(403).json({ message: "No access to this document" });
    }

    const fileName = `${sanitizeFilename(doc.title)}.pdf`;
    const plainTextContent = stripHtml(doc.content || "");
    const generatedAt = new Date().toLocaleString();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    const pdf = new PDFDocument({
      size: "A4",
      margin: 50
    });

    pdf.pipe(res);

    pdf
      .fontSize(20)
      .fillColor("#0f172a")
      .text(doc.title || "Untitled Document");

    pdf.moveDown(0.4);
    pdf
      .fontSize(10)
      .fillColor("#475569")
      .text(`Generated on: ${generatedAt}`);

    pdf.moveDown(1);
    pdf
      .fontSize(12)
      .fillColor("#111827")
      .text(plainTextContent || "No content available.", {
        lineGap: 3
      });

    pdf.end();
    return undefined;
  } catch {
    return res.status(500).json({ message: "Could not export PDF" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.canEdit) {
      return res.status(403).json({ message: "Only owners/editors can update this document" });
    }

    const hasTitle = typeof req.body?.title === "string";
    const hasContent = typeof req.body?.content === "string";

    if (!hasTitle && !hasContent) {
      return res.status(400).json({ message: "No updates provided" });
    }

    const nextTitle = hasTitle
      ? String(req.body.title).trim() || "Untitled Document"
      : doc.title;
    const nextContent = hasContent ? req.body.content : doc.content;
    const hasChanges = nextTitle !== doc.title || nextContent !== doc.content;

    if (hasChanges) {
      snapshotCurrentVersion(doc, req.user.id, Boolean(req.body?.forceVersion));
      doc.title = nextTitle;
      doc.content = nextContent;
      await doc.save();
    }

    const updated = await findPopulatedDocById(req.params.id);
    return res.json(serializeDocument(updated, req.user));
  } catch {
    return res.status(500).json({ message: "Could not update document" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.isOwner) {
      return res.status(403).json({ message: "Only the owner can delete this document" });
    }

    await doc.deleteOne();
    return res.json({ message: "Document deleted" });
  } catch {
    return res.status(500).json({ message: "Could not delete document" });
  }
});

router.post("/:id/share", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const role = normalizeRole(req.body?.role);

    if (!email) {
      return res.status(400).json({ message: "Collaborator email is required" });
    }

    const doc = await Document.findById(req.params.id).populate("owner", "name email");

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.isOwner) {
      return res.status(403).json({ message: "Only the owner can share this document" });
    }

    const ownerEmail = normalizeEmail(doc.owner?.email);
    if (email === ownerEmail) {
      return res.status(400).json({ message: "Owner already has full access" });
    }

    const userToShare = await User.findOne({ email });
    const existingShare = findMatchingShareEntry(doc, email, userToShare?._id);

    if (existingShare) {
      existingShare.role = role;
      existingShare.email = email;
      if (userToShare) {
        existingShare.user = userToShare._id;
      }
    } else {
      doc.sharedWith.push({
        user: userToShare?._id,
        email,
        role
      });
    }

    const pendingRequest = doc.editRequests.find(
      (request) => normalizeEmail(request.email) === email && request.status === "pending"
    );
    if (pendingRequest) {
      pendingRequest.status = "approved";
    }

    await doc.save();

    const updated = await findPopulatedDocById(req.params.id);
    return res.json(serializeDocument(updated, req.user));
  } catch {
    return res.status(500).json({ message: "Could not share document" });
  }
});

router.delete("/:id/share/:shareId", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.isOwner) {
      return res.status(403).json({ message: "Only the owner can remove collaborators" });
    }

    const shareEntry = doc.sharedWith.id(req.params.shareId);
    if (!shareEntry) {
      return res.status(404).json({ message: "Collaborator not found" });
    }

    shareEntry.deleteOne();
    await doc.save();

    const updated = await findPopulatedDocById(req.params.id);
    return res.json(serializeDocument(updated, req.user));
  } catch {
    return res.status(500).json({ message: "Could not remove collaborator" });
  }
});

router.put("/:id/link-access", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.isOwner) {
      return res.status(403).json({ message: "Only the owner can update link access" });
    }

    doc.linkAccess = normalizeLinkAccess(req.body?.linkAccess);
    await doc.save();

    const updated = await findPopulatedDocById(req.params.id);
    return res.json(serializeDocument(updated, req.user));
  } catch {
    return res.status(500).json({ message: "Could not update link access" });
  }
});

router.post("/:id/request-edit", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);

    if (access.canEdit || access.isOwner) {
      return res.status(400).json({ message: "You already have edit access" });
    }

    const email = normalizeEmail(req.user.email);
    const message = String(req.body?.message || "Please grant me edit access.").trim().slice(0, 300);

    const pendingRequest = doc.editRequests.find(
      (request) => normalizeEmail(request.email) === email && request.status === "pending"
    );
    if (pendingRequest) {
      return res.status(400).json({ message: "Edit request already pending" });
    }

    const existingRequest = doc.editRequests.find(
      (request) => normalizeEmail(request.email) === email
    );

    if (existingRequest) {
      existingRequest.status = "pending";
      existingRequest.message = message || existingRequest.message;
      existingRequest.user = req.user.id;
      existingRequest.name = req.user.name;
    } else {
      doc.editRequests.push({
        user: req.user.id,
        email,
        name: req.user.name,
        message: message || "Please grant me edit access.",
        status: "pending"
      });
    }

    await doc.save();

    const updated = await findPopulatedDocById(req.params.id);
    return res.json({
      message: "Edit request sent to owner",
      doc: serializeDocument(updated, req.user)
    });
  } catch {
    return res.status(500).json({ message: "Could not send edit request" });
  }
});

router.post("/:id/requests/:requestId", async (req, res) => {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ message: "Action must be approve or reject" });
    }

    const doc = await Document.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.isOwner) {
      return res.status(403).json({ message: "Only the owner can review edit requests" });
    }

    const targetRequest = doc.editRequests.id(req.params.requestId);
    if (!targetRequest) {
      return res.status(404).json({ message: "Edit request not found" });
    }

    if (action === "approve") {
      targetRequest.status = "approved";

      const email = normalizeEmail(targetRequest.email);
      const matchedUser = targetRequest.user
        ? await User.findById(targetRequest.user)
        : await User.findOne({ email });

      const shareEntry = findMatchingShareEntry(doc, email, matchedUser?._id);

      if (shareEntry) {
        shareEntry.role = "editor";
        shareEntry.email = email;
        if (matchedUser) {
          shareEntry.user = matchedUser._id;
        }
      } else {
        doc.sharedWith.push({
          user: matchedUser?._id,
          email,
          role: "editor"
        });
      }
    } else {
      targetRequest.status = "rejected";
    }

    await doc.save();

    const updated = await findPopulatedDocById(req.params.id);
    return res.json(serializeDocument(updated, req.user));
  } catch {
    return res.status(500).json({ message: "Could not update edit request" });
  }
});

router.get("/:id/versions", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).populate("versions.editedBy", "name email");

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.canView) {
      return res.status(403).json({ message: "No access to this document" });
    }

    return res.json(serializeVersions(doc));
  } catch {
    return res.status(500).json({ message: "Could not fetch versions" });
  }
});

router.post("/:id/restore/:versionId", async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return res.status(404).json({ message: "Document not found" });
    }

    const access = getDocumentAccess(doc, req.user);
    if (!access.canEdit) {
      return res.status(403).json({ message: "Only owners/editors can restore versions" });
    }

    const targetVersion = doc.versions.id(req.params.versionId);
    if (!targetVersion) {
      return res.status(404).json({ message: "Version not found" });
    }

    snapshotCurrentVersion(doc, req.user.id, true);

    doc.title = targetVersion.title || "Untitled Document";
    doc.content = targetVersion.content || "";

    await doc.save();

    const restoredDoc = await findPopulatedDocById(req.params.id);
    return res.json(serializeDocument(restoredDoc, req.user));
  } catch {
    return res.status(500).json({ message: "Could not restore version" });
  }
});

export default router;
