import mongoose from "mongoose";

const versionSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  content: {
    type: String,
    default: ""
  },
  editedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  _id: true
});

const sharedWithSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  role: {
    type: String,
    enum: ["viewer", "editor"],
    default: "viewer"
  }
}, {
  _id: true
});

const editRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    default: ""
  },
  message: {
    type: String,
    default: "Please grant me edit access."
  },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending"
  }
}, {
  _id: true,
  timestamps: true
});

const documentSchema = new mongoose.Schema({
  title: {
    type: String,
    default: "Untitled Document",
    trim: true
  },
  content: {
    type: String,
    default: ""
  },
  linkAccess: {
    type: String,
    enum: ["restricted", "viewer", "editor"],
    default: "restricted"
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  sharedWith: [sharedWithSchema],
  editRequests: [editRequestSchema],
  versions: [versionSchema]
}, {
  timestamps: true
});

export default mongoose.model("Document", documentSchema);
