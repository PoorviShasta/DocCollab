const VERSION_SNAPSHOT_COOLDOWN_MS = 15000;
const MAX_VERSION_ENTRIES = 50;

export const normalizeRole = (role) => (role === "editor" ? "editor" : "viewer");
export const normalizeLinkAccess = (linkAccess) => {
  if (linkAccess === "editor") {
    return "editor";
  }

  if (linkAccess === "viewer") {
    return "viewer";
  }

  return "restricted";
};

const toLower = (value) => String(value || "").toLowerCase();

export const getDocumentAccess = (doc, user) => {
  const userId = String(user?.id || "");
  const userEmail = toLower(user?.email);
  const ownerId = String(doc.owner?._id || doc.owner || "");

  if (ownerId === userId) {
    return {
      isOwner: true,
      role: "owner",
      canView: true,
      canEdit: true,
      viaLink: false
    };
  }

  const sharedEntry = (doc.sharedWith || []).find((entry) => {
    const sharedUser = entry?.user;
    const sharedUserId = String(sharedUser?._id || sharedUser || "");
    const sharedUserEmail = toLower(entry?.email || sharedUser?.email || sharedUser);

    return sharedUserId === userId || (userEmail && sharedUserEmail === userEmail);
  });

  if (sharedEntry) {
    const role = normalizeRole(sharedEntry.role);

    return {
      isOwner: false,
      role,
      canView: true,
      canEdit: role === "editor",
      viaLink: false
    };
  }

  const linkAccess = normalizeLinkAccess(doc.linkAccess);

  if (linkAccess === "viewer" || linkAccess === "editor") {
    return {
      isOwner: false,
      role: "editor",
      canView: true,
      canEdit: true,
      viaLink: true
    };
  }

  return {
    isOwner: false,
    role: null,
    canView: false,
    canEdit: false,
    viaLink: false
  };
};

export const snapshotCurrentVersion = (doc, userId, force = false) => {
  const lastVersion = doc.versions?.[0];
  const enoughTimePassed = !lastVersion || (
    Date.now() - new Date(lastVersion.createdAt).getTime() > VERSION_SNAPSHOT_COOLDOWN_MS
  );

  if (!force && !enoughTimePassed) {
    return false;
  }

  doc.versions.unshift({
    title: doc.title || "Untitled Document",
    content: doc.content || "",
    editedBy: userId
  });

  if (doc.versions.length > MAX_VERSION_ENTRIES) {
    doc.versions = doc.versions.slice(0, MAX_VERSION_ENTRIES);
  }

  return true;
};

const isMongooseObjectIdLike = (value) => (
  value &&
  typeof value === "object" &&
  value.constructor &&
  value.constructor.name === "ObjectId"
);

export const serializeUser = (user) => {
  if (!user) {
    return null;
  }

  if (typeof user === "string" || isMongooseObjectIdLike(user)) {
    return {
      _id: String(user),
      name: "",
      email: ""
    };
  }

  return {
    _id: String(user._id || ""),
    name: user.name || "",
    email: user.email || ""
  };
};

const serializeEditRequest = (request) => ({
  _id: String(request._id),
  user: serializeUser(request.user),
  email: request.email || "",
  name: request.name || "",
  message: request.message || "",
  status: request.status || "pending",
  createdAt: request.createdAt,
  updatedAt: request.updatedAt
});

export const serializeDocument = (doc, user, options = {}) => {
  const permissions = getDocumentAccess(doc, user);
  const userEmail = toLower(user?.email);
  const shouldRedact = Boolean(options.redactForNoView && !permissions.canView);

  const ownerVisibleRequests = permissions.isOwner
    ? (doc.editRequests || []).map(serializeEditRequest)
    : [];

  const ownViewerRequests = permissions.isOwner
    ? []
    : (doc.editRequests || [])
      .filter((request) => toLower(request.email) === userEmail)
      .map(serializeEditRequest);

  return {
    _id: String(doc._id),
    title: doc.title,
    content: shouldRedact ? "" : doc.content,
    linkAccess: normalizeLinkAccess(doc.linkAccess),
    owner: serializeUser(doc.owner),
    sharedWith: shouldRedact
      ? []
      : (doc.sharedWith || []).map((entry) => ({
        _id: String(entry._id),
        user: serializeUser(entry.user),
        email: entry.email || entry.user?.email || "",
        role: normalizeRole(entry.role)
      })),
    editRequests: permissions.isOwner ? ownerVisibleRequests : ownViewerRequests,
    permissions,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
};

export const serializeVersions = (doc) => (
  (doc.versions || []).map((version) => ({
    _id: String(version._id),
    title: version.title,
    content: version.content,
    editedBy: serializeUser(version.editedBy),
    createdAt: version.createdAt
  }))
);
