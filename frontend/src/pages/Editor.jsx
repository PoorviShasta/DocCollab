import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import API from "../api";
import socket from "../socket";
import { getAuthUser, getToken } from "../utils/auth";

const AUTOSAVE_INTERVAL_MS = 4000;
const MAX_EMBED_FILE_BYTES = 3 * 1024 * 1024;

const escapeHtml = (value) => String(value || "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const ensureHtmlContent = (value) => {
  const raw = String(value || "");

  if (!raw.trim()) {
    return "<p><br></p>";
  }

  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(raw);
  if (looksLikeHtml) {
    return raw;
  }

  return `<p>${escapeHtml(raw).replace(/\n/g, "<br>")}</p>`;
};

const readFileAsDataUrl = (file) => (
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  })
);

const normalizeLinkAccessValue = (value) => (value === "restricted" ? "restricted" : "anyone");
const parseFilenameFromDisposition = (contentDisposition, fallbackName) => {
  const utf8Match = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const basicMatch = contentDisposition?.match(/filename="([^"]+)"/i);
  if (basicMatch?.[1]) {
    return basicMatch[1];
  }

  return fallbackName;
};
const getSafeFileName = (value) => (
  String(value || "document")
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "document"
);

function Editor() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const currentUser = useMemo(() => getAuthUser(), []);

  const [doc, setDoc] = useState(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("<p><br></p>");
  const [participants, setParticipants] = useState([]);
  const [shareEmail, setShareEmail] = useState("");
  const [shareRole, setShareRole] = useState("viewer");
  const [linkAccess, setLinkAccess] = useState("restricted");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [error, setError] = useState("");
  const [shareError, setShareError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [updatingLinkAccess, setUpdatingLinkAccess] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const pendingChangesRef = useRef(false);
  const savingRef = useRef(false);
  const editorRef = useRef(null);
  const imageInputRef = useRef(null);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const html = content || "<p><br></p>";
    if (editor.innerHTML !== html) {
      editor.innerHTML = html;
    }
  }, [content]);

  const applyLoadedDoc = useCallback((incomingDoc, nextSaveStatus = "Saved") => {
    const normalizedContent = ensureHtmlContent(incomingDoc?.content || "");

    setDoc(incomingDoc);
    setTitle(incomingDoc?.title || "Untitled Document");
    setContent(normalizedContent);
    setLinkAccess(normalizeLinkAccessValue(incomingDoc?.linkAccess));
    pendingChangesRef.current = false;
    setSaveStatus(nextSaveStatus);
  }, []);

  const fetchDoc = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const res = await API.get(`/doc/${id}`);
      applyLoadedDoc(res.data, "Saved");
    } catch (err) {
      const deniedDoc = err.response?.data?.doc;
      if (deniedDoc) {
        applyLoadedDoc(deniedDoc, "Read only");
        setError(err.response?.data?.message || "You do not have access yet.");
      } else {
        setError(err.response?.data?.message || "Unable to load document.");
      }
    } finally {
      setLoading(false);
    }
  }, [applyLoadedDoc, id]);

  useEffect(() => {
    fetchDoc();
  }, [fetchDoc]);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      navigate("/");
      return undefined;
    }

    socket.auth = { token };
    if (!socket.connected) {
      socket.connect();
    }

    const joinRoom = () => {
      socket.emit("join-doc", { docId: id }, (response) => {
        if (response?.ok === false) {
          setError(response.message || "Could not join document room.");
        }
      });
    };

    const onLoadDoc = ({ doc: incomingDoc, participants: incomingParticipants }) => {
      if (!incomingDoc || incomingDoc._id !== id) {
        return;
      }

      applyLoadedDoc(incomingDoc, "Synced");
      setParticipants(incomingParticipants || []);
    };

    const onReceiveChanges = ({ content: nextContent, title: nextTitle, updatedBy }) => {
      if (typeof nextContent === "string") {
        setContent(ensureHtmlContent(nextContent));
      }
      if (typeof nextTitle === "string") {
        setTitle(nextTitle);
      }

      setSaveStatus(`Live update from ${updatedBy?.name || "teammate"}`);
    };

    const onPresenceUpdate = (nextParticipants) => {
      setParticipants(nextParticipants || []);
    };

    const onDocSaved = ({ docId: savedDocId, title: savedTitle, content: savedContent, linkAccess: savedLinkAccess, updatedAt }) => {
      if (String(savedDocId || "") !== id) {
        return;
      }

      setDoc((prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          title: typeof savedTitle === "string" ? savedTitle : prev.title,
          content: typeof savedContent === "string" ? savedContent : prev.content,
          linkAccess: savedLinkAccess || prev.linkAccess,
          updatedAt: updatedAt || prev.updatedAt
        };
      });

      if (typeof savedTitle === "string") {
        setTitle(savedTitle);
      }
      if (typeof savedContent === "string") {
        setContent(ensureHtmlContent(savedContent));
      }
      setLinkAccess(normalizeLinkAccessValue(savedLinkAccess));
    };

    const onConnectError = () => {
      setError("Socket connection failed. Real-time sync may be unavailable.");
    };

    socket.on("connect", joinRoom);
    socket.on("load-doc", onLoadDoc);
    socket.on("receive-changes", onReceiveChanges);
    socket.on("presence-update", onPresenceUpdate);
    socket.on("doc-saved", onDocSaved);
    socket.on("connect_error", onConnectError);

    if (socket.connected) {
      joinRoom();
    }

    return () => {
      socket.emit("leave-doc", { docId: id });
      socket.off("connect", joinRoom);
      socket.off("load-doc", onLoadDoc);
      socket.off("receive-changes", onReceiveChanges);
      socket.off("presence-update", onPresenceUpdate);
      socket.off("doc-saved", onDocSaved);
      socket.off("connect_error", onConnectError);
    };
  }, [applyLoadedDoc, id, navigate]);

  const requestedModeParam = searchParams.get("mode");
  const requestedMode = requestedModeParam === "viewer" || requestedModeParam === "editor"
    ? requestedModeParam
    : null;
  const rawCanEdit = Boolean(doc?.permissions?.canEdit);
  const canEdit = rawCanEdit && requestedMode !== "viewer";
  const canView = Boolean(doc?.permissions?.canView);
  const isOwner = Boolean(doc?.permissions?.isOwner);

  useEffect(() => {
    if (!canEdit) {
      return undefined;
    }

    const timer = setInterval(async () => {
      if (!pendingChangesRef.current || savingRef.current) {
        return;
      }

      try {
        setSaving(true);
        setSaveStatus("Saving...");

        const res = await API.put(`/doc/${id}`, {
          title: titleRef.current,
          content: contentRef.current
        });

        setDoc(res.data);
        setLinkAccess(normalizeLinkAccessValue(res.data.linkAccess));
        pendingChangesRef.current = false;
        setSaveStatus("Saved");
      } catch (err) {
        setSaveStatus("Save failed");
        setError(err.response?.data?.message || "Could not save changes.");
      } finally {
        setSaving(false);
      }
    }, AUTOSAVE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [canEdit, id]);

  const shareMode = linkAccess === "restricted" ? shareRole : "editor";
  const shareLink = `${window.location.origin}/editor/${id}?mode=${shareMode}`;
  const roleLabel = isOwner ? "owner" : doc?.permissions?.role || "no-access";

  const markDirtyAndBroadcast = useCallback((nextTitleForEmit = titleRef.current) => {
    if (!canEdit || !editorRef.current) {
      return;
    }

    const nextContent = editorRef.current.innerHTML;
    setContent(nextContent);
    pendingChangesRef.current = true;
    setSaveStatus("Unsaved changes");

    socket.emit("send-changes", {
      docId: id,
      title: nextTitleForEmit,
      content: nextContent
    });
  }, [canEdit, id]);

  const handleTitleChange = (event) => {
    if (!canEdit) {
      return;
    }

    const nextTitle = event.target.value;
    setTitle(nextTitle);
    pendingChangesRef.current = true;
    setSaveStatus("Unsaved changes");

    socket.emit("send-changes", {
      docId: id,
      title: nextTitle,
      content: contentRef.current
    });
  };

  const handleEditorInput = () => {
    markDirtyAndBroadcast(titleRef.current);
  };

  const runEditorCommand = (command, value = null) => {
    if (!canEdit || !editorRef.current) {
      return;
    }

    editorRef.current.focus();
    document.execCommand(command, false, value);
    markDirtyAndBroadcast(titleRef.current);
  };

  const insertLink = () => {
    if (!canEdit) {
      return;
    }

    const url = window.prompt("Enter link URL");
    if (!url) {
      return;
    }

    const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    runEditorCommand("createLink", normalizedUrl);
  };

  const handleInsertImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (file.size > MAX_EMBED_FILE_BYTES) {
      setError("Image is too large. Use files under 3MB.");
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      runEditorCommand("insertImage", dataUrl);
    } catch {
      setError("Could not insert image.");
    }
  };


  const shareDocument = async (event) => {
    event.preventDefault();

    if (!shareEmail.trim()) {
      setShareError("Please enter a collaborator email.");
      return;
    }

    try {
      setShareError("");
      const res = await API.post(`/doc/${id}/share`, {
        email: shareEmail.trim(),
        role: shareRole
      });

      setDoc(res.data);
      setLinkAccess(normalizeLinkAccessValue(res.data.linkAccess || linkAccess));
      setShareEmail("");
    } catch (err) {
      setShareError(err.response?.data?.message || "Could not share document.");
    }
  };

  const updateDocumentLinkAccess = async (nextLinkAccess) => {
    if (!isOwner) {
      return;
    }

    const normalizedNextLinkAccess = normalizeLinkAccessValue(nextLinkAccess);
    const apiLinkAccess = normalizedNextLinkAccess === "anyone" ? "editor" : "restricted";
    const previous = linkAccess;
    setLinkAccess(normalizedNextLinkAccess);
    setUpdatingLinkAccess(true);

    try {
      setShareError("");
      const res = await API.put(`/doc/${id}/link-access`, { linkAccess: apiLinkAccess });
      setDoc(res.data);
      setLinkAccess(normalizeLinkAccessValue(res.data.linkAccess || normalizedNextLinkAccess));
    } catch (err) {
      setLinkAccess(previous);
      setShareError(err.response?.data?.message || "Could not update link access.");
    } finally {
      setUpdatingLinkAccess(false);
    }
  };

  const removeCollaborator = async (shareId) => {
    try {
      const res = await API.delete(`/doc/${id}/share/${shareId}`);
      setDoc(res.data);
    } catch (err) {
      setShareError(err.response?.data?.message || "Could not remove collaborator.");
    }
  };

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopyStatus("Link copied");
      setTimeout(() => setCopyStatus(""), 2000);
    } catch {
      setCopyStatus("Copy failed");
      setTimeout(() => setCopyStatus(""), 2000);
    }
  };

  const downloadPdf = async () => {
    if (!canView) {
      return;
    }

    try {
      setDownloadingPdf(true);
      setError("");

      const res = await API.get(`/doc/${id}/export/pdf`, {
        responseType: "blob"
      });

      const fallbackName = `${getSafeFileName(title)}.pdf`;
      const fileName = parseFilenameFromDisposition(
        res.headers?.["content-disposition"],
        fallbackName
      );

      const fileUrl = window.URL.createObjectURL(res.data);
      const link = document.createElement("a");
      link.href = fileUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(fileUrl);
    } catch (err) {
      setError(err.response?.data?.message || "Could not download PDF.");
    } finally {
      setDownloadingPdf(false);
    }
  };

  const deleteDocument = async () => {
    const confirmed = window.confirm("Delete this document permanently?");
    if (!confirmed) {
      return;
    }

    try {
      await API.delete(`/doc/${id}`);
      navigate("/dashboard");
    } catch (err) {
      setError(err.response?.data?.message || "Could not delete document.");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-sm text-slate-600">Loading editor...</p>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-sm text-red-600">{error || "Document not available."}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-6">
      <div className="mx-auto grid w-full max-w-7xl gap-4 lg:grid-cols-[2fr_1fr]">
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <header className="mb-4 flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 flex-1">
              <input
                value={title}
                onChange={handleTitleChange}
                disabled={!canEdit}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-lg font-semibold text-slate-900 outline-none transition focus:border-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100"
              />
              <p className="mt-1 text-xs text-slate-500">
                Role: {roleLabel}
                {doc.permissions?.viaLink ? " (via link)" : ""}
                {requestedMode ? ` | Link mode: ${requestedMode}` : ""}
                {" | "}
                Save status: {saveStatus}
                {saving ? "..." : ""}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => navigate("/dashboard")}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
              >
                Back
              </button>
              <button
                onClick={() => setShowSharePanel((prev) => !prev)}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                {showSharePanel ? "Close Share" : "Share"}
              </button>
              <button
                onClick={downloadPdf}
                disabled={!canView || downloadingPdf}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {downloadingPdf ? "Preparing PDF..." : "Download PDF"}
              </button>
              {isOwner ? (
                <button
                  onClick={deleteDocument}
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100"
                >
                  Delete
                </button>
              ) : null}
            </div>
          </header>

          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-gradient-to-r from-slate-50 to-sky-50 p-2">
            <button
              onClick={() => runEditorCommand("formatBlock", "<h1>")}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              H1
            </button>
            <button
              onClick={() => runEditorCommand("formatBlock", "<h2>")}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              H2
            </button>
            <button
              onClick={() => runEditorCommand("formatBlock", "<p>")}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Body
            </button>
            <button
              onClick={() => runEditorCommand("bold")}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Bold
            </button>
            <button
              onClick={() => runEditorCommand("italic")}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Italic
            </button>
            <button
              onClick={() => runEditorCommand("underline")}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Underline
            </button>
            <button
              onClick={insertLink}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Insert Link
            </button>
            <button
              onClick={() => imageInputRef.current?.click()}
              disabled={!canEdit}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Insert Image
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleInsertImage}
            />
          </div>

          {error ? (
            <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          ) : null}

          {!canView ? (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              You cannot view content right now.
            </p>
          ) : null}

          <div
            ref={editorRef}
            contentEditable={canEdit}
            suppressContentEditableWarning
            onInput={handleEditorInput}
            className="doc-editor h-[60vh] w-full overflow-auto rounded-xl border border-slate-300 p-4 text-sm leading-6 text-slate-800 outline-none transition focus:border-slate-900 disabled:bg-slate-100"
          />
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Live Presence</h2>
            <p className="mt-1 text-xs text-slate-500">{participants.length} user(s) in this doc</p>
            <div className="mt-3 space-y-2">
              {participants.length === 0 ? (
                <p className="text-xs text-slate-500">No active users.</p>
              ) : (
                participants.map((participant) => (
                  <div key={participant.socketId} className="rounded-lg border border-slate-200 p-2">
                    <p className="text-sm font-medium text-slate-800">
                      {participant.name}
                      {participant.userId === currentUser?.id ? " (You)" : ""}
                    </p>
                    <p className="text-xs text-slate-500">{participant.email}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section
            className={`overflow-hidden rounded-2xl bg-white p-4 shadow-sm transition-all duration-300 ${
              showSharePanel ? "max-h-[1200px] opacity-100" : "max-h-24 opacity-95"
            }`}
          >
            {showSharePanel ? (
              <div className="animate-fade-in space-y-3">
                <h2 className="text-sm font-semibold text-slate-900">Access Settings</h2>

                <div className="rounded-lg border border-slate-200 p-2">
                  <p className="text-xs text-slate-500">Copy link</p>
                  <p className="truncate text-xs text-slate-700">{shareLink}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Link opens in {shareMode} mode.
                  </p>
                  <button
                    onClick={copyShareLink}
                    className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 transition-all duration-200 hover:border-slate-500 hover:bg-slate-50"
                  >
                    {copyStatus || "Copy link"}
                  </button>
                </div>

                <div className="rounded-lg border border-slate-200 p-2">
                  <p className="text-xs text-slate-500">Link access</p>
                  {isOwner ? (
                    <select
                      value={linkAccess}
                      onChange={(event) => updateDocumentLinkAccess(event.target.value)}
                      disabled={updatingLinkAccess}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm outline-none transition focus:border-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100"
                    >
                      <option value="restricted">Restricted</option>
                      <option value="anyone">Anyone with link</option>
                    </select>
                  ) : (
                    <p className="mt-1 text-xs text-slate-700">
                      {linkAccess === "restricted" ? "Restricted" : "Anyone with link (editor mode)"}
                    </p>
                  )}
                </div>

                {isOwner && linkAccess === "restricted" ? (
                  <form className="space-y-2 rounded-lg border border-slate-200 p-2" onSubmit={shareDocument}>
                    <p className="text-xs text-slate-500">Give access</p>
                    <input
                      type="email"
                      value={shareEmail}
                      onChange={(event) => setShareEmail(event.target.value)}
                      placeholder="teammate@email.com"
                      className="w-full rounded border border-slate-300 px-2 py-2 text-sm outline-none transition focus:border-slate-900"
                    />
                    <select
                      value={shareRole}
                      onChange={(event) => setShareRole(event.target.value)}
                      className="w-full rounded border border-slate-300 px-2 py-2 text-sm outline-none transition focus:border-slate-900"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                    <button
                      type="submit"
                      className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-slate-800"
                    >
                      Add Collaborator
                    </button>
                  </form>
                ) : null}

                {shareError ? (
                  <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600">
                    {shareError}
                  </p>
                ) : null}

                <div className="space-y-2">
                  <p className="text-xs text-slate-500">People with access</p>
                  {(doc.sharedWith || []).length === 0 ? (
                    <p className="text-xs text-slate-500">No direct collaborators added.</p>
                  ) : (
                    doc.sharedWith.map((entry) => (
                      <div key={entry._id} className="rounded-lg border border-slate-200 p-2">
                        <p className="text-sm font-medium text-slate-800">{entry.user?.name || entry.email}</p>
                        <p className="text-xs text-slate-500">{entry.user?.email || entry.email}</p>
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                            {entry.role}
                          </span>
                          {isOwner ? (
                            <button
                              onClick={() => removeCollaborator(entry._id)}
                              className="text-xs font-medium text-red-600 transition-colors hover:text-red-500"
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-700">
                Click <span className="font-semibold">Share</span> to copy link and manage access.
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

export default Editor;
