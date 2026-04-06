import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import API from "../api";
import socket from "../socket";
import { clearToken, getAuthUser } from "../utils/auth";

function Dashboard() {
  const [docs, setDocs] = useState([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const user = useMemo(() => getAuthUser(), []);

  const fetchDocs = async () => {
    try {
      setLoading(true);
      const res = await API.get("/doc");
      setDocs(res.data || []);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load documents.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocs();
  }, []);

  const createDoc = async () => {
    try {
      setCreating(true);
      setError("");

      const res = await API.post("/doc/create", {
        title: title.trim() || "Untitled Document",
        content: ""
      });

      setTitle("");
      navigate(`/editor/${res.data._id}`);
    } catch (err) {
      setError(err.response?.data?.message || "Could not create document.");
    } finally {
      setCreating(false);
    }
  };

  const deleteDoc = async (docId) => {
    const confirmed = window.confirm("Delete this document permanently?");
    if (!confirmed) {
      return;
    }

    try {
      await API.delete(`/doc/${docId}`);
      setDocs((prev) => prev.filter((doc) => doc._id !== docId));
    } catch (err) {
      setError(err.response?.data?.message || "Could not delete document.");
    }
  };

  const logout = () => {
    clearToken();
    socket.disconnect();
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">CollabDocs Dashboard</h1>
              <p className="text-sm text-slate-600">
                Signed in as {user?.name || "User"} ({user?.email || "no-email"})
              </p>
            </div>
            <button
              onClick={logout}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Logout
            </button>
          </div>
        </header>

        <section className="mb-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Create New Document</h2>
          <div className="mt-4 flex flex-col gap-3 md:flex-row">
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Document title (optional)"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 outline-none transition focus:border-slate-900"
            />
            <button
              onClick={createDoc}
              disabled={creating}
              className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Your Documents</h2>
            <button
              onClick={fetchDocs}
              className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-700 transition hover:bg-slate-100"
            >
              Refresh
            </button>
          </div>

          {error ? (
            <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          ) : null}

          {loading ? (
            <p className="text-sm text-slate-500">Loading documents...</p>
          ) : null}

          {!loading && docs.length === 0 ? (
            <p className="text-sm text-slate-500">No documents yet. Create one to get started.</p>
          ) : null}

          <div className="space-y-3">
            {docs.map((doc) => (
              <div
                key={doc._id}
                className="rounded-xl border border-slate-200 p-4 transition hover:border-slate-300"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">{doc.title}</h3>
                    <p className="mt-1 text-sm text-slate-600">{doc.preview || "No content yet."}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-slate-200 px-2 py-1 font-medium text-slate-700">
                        Role: {doc.permissions?.role || "none"}
                      </span>
                      <span className="rounded-full bg-slate-200 px-2 py-1 font-medium text-slate-700">
                        Updated: {new Date(doc.updatedAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => navigate(`/editor/${doc._id}`)}
                      className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600"
                    >
                      Open
                    </button>
                    {doc.permissions?.isOwner ? (
                      <button
                        onClick={() => deleteDoc(doc._id)}
                        className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100"
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Dashboard;
