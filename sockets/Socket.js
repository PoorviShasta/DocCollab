import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import Document from "../models/Document.js";
import {
  getDocumentAccess,
  normalizeLinkAccess,
  serializeDocument,
  snapshotCurrentVersion
} from "../utils/documentAccess.js";

const activeParticipants = new Map();

const roomKey = (docId) => String(docId);

const serializeParticipantMap = (participantsBySocket) => (
  Array.from(participantsBySocket.values()).map((participant) => ({
    socketId: participant.socketId,
    userId: participant.userId,
    name: participant.name,
    email: participant.email
  }))
);

const emitPresence = (io, docId) => {
  const roomId = roomKey(docId);
  const participantsBySocket = activeParticipants.get(roomId) || new Map();
  io.to(roomId).emit("presence-update", serializeParticipantMap(participantsBySocket));
};

const clearSocketFromRoomState = (io, socket, roomId) => {
  const participantsBySocket = activeParticipants.get(roomId);
  if (participantsBySocket?.has(socket.id)) {
    participantsBySocket.delete(socket.id);

    if (participantsBySocket.size === 0) {
      activeParticipants.delete(roomId);
    }

    emitPresence(io, roomId);
  }
};

const withDocumentAccess = async (docId, socket, shouldEdit = false) => {
  const doc = await Document.findById(docId)
    .populate("owner", "name email")
    .populate("sharedWith.user", "name email")
    .populate("editRequests.user", "name email");

  if (!doc) {
    return { ok: false, code: 404, message: "Document not found" };
  }

  const access = getDocumentAccess(doc, socket.user);

  if (!access.canView) {
    return { ok: false, code: 403, message: "No access to this document" };
  }

  if (shouldEdit && !access.canEdit) {
    return { ok: false, code: 403, message: "Edit access required" };
  }

  return { ok: true, doc, access };
};

export const initSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) || "http://localhost:5173"
    }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Unauthorized"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      socket.user = {
        id: String(decoded.id),
        name: decoded.name || "Unknown user",
        email: decoded.email || ""
      };

      return next();
    } catch {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.on("join-doc", async ({ docId }, ack) => {
      const roomId = roomKey(docId);

      if (socket.data.currentRoomId && socket.data.currentRoomId !== roomId) {
        socket.leave(socket.data.currentRoomId);
        clearSocketFromRoomState(io, socket, socket.data.currentRoomId);
      }

      const result = await withDocumentAccess(docId, socket, false);

      if (!result.ok) {
        if (typeof ack === "function") {
          ack({ ok: false, message: result.message, code: result.code });
        }
        return;
      }

      socket.join(roomId);
      socket.data.currentRoomId = roomId;

      const roomParticipants = activeParticipants.get(roomId) || new Map();
      roomParticipants.set(socket.id, {
        socketId: socket.id,
        userId: socket.user.id,
        name: socket.user.name,
        email: socket.user.email
      });
      activeParticipants.set(roomId, roomParticipants);

      socket.emit("load-doc", {
        doc: serializeDocument(result.doc, socket.user),
        participants: serializeParticipantMap(roomParticipants)
      });

      emitPresence(io, roomId);

      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("leave-doc", ({ docId }) => {
      const roomId = roomKey(docId);
      socket.leave(roomId);
      clearSocketFromRoomState(io, socket, roomId);

      if (socket.data.currentRoomId === roomId) {
        socket.data.currentRoomId = null;
      }
    });

    socket.on("send-changes", async ({ docId, content, title }) => {
      const result = await withDocumentAccess(docId, socket, true);
      if (!result.ok) {
        return;
      }

      socket.to(roomKey(docId)).emit("receive-changes", {
        content: typeof content === "string" ? content : result.doc.content,
        title: typeof title === "string" ? title : result.doc.title,
        updatedBy: {
          id: socket.user.id,
          name: socket.user.name
        }
      });
    });

    socket.on("save-doc", async ({ docId, content, title, forceVersion }, ack) => {
      const result = await withDocumentAccess(docId, socket, true);
      if (!result.ok) {
        if (typeof ack === "function") {
          ack({ ok: false, message: result.message, code: result.code });
        }
        return;
      }

      const doc = await Document.findById(docId);
      if (!doc) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "Document not found", code: 404 });
        }
        return;
      }

      const nextTitle = typeof title === "string"
        ? (title.trim() || "Untitled Document")
        : doc.title;
      const nextContent = typeof content === "string" ? content : doc.content;
      const hasChanges = nextTitle !== doc.title || nextContent !== doc.content;

      if (hasChanges) {
        snapshotCurrentVersion(doc, socket.user.id, Boolean(forceVersion));
        doc.title = nextTitle;
        doc.content = nextContent;
        await doc.save();
      }

      io.to(roomKey(docId)).emit("doc-saved", {
        docId: String(doc._id),
        title: doc.title,
        content: doc.content,
        linkAccess: normalizeLinkAccess(doc.linkAccess),
        updatedAt: doc.updatedAt,
        savedBy: {
          id: socket.user.id,
          name: socket.user.name
        }
      });

      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("disconnect", () => {
      if (socket.data.currentRoomId) {
        clearSocketFromRoomState(io, socket, socket.data.currentRoomId);
      }
    });
  });
};
