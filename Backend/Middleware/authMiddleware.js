import jwt from "jsonwebtoken";
import User from "../models/User.js";

export default async function protect(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "No token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("name email");

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = {
      id: String(user._id),
      name: user.name,
      email: user.email
    };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}
