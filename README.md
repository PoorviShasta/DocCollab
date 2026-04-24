# CollabDocs (Real-time Document Editor)

A full-stack collaborative editor built with:

- Frontend: React (Vite), Tailwind CSS, Axios, React Router DOM, Socket.io-client
- Backend: Node.js, Express, MongoDB + Mongoose, JWT + bcrypt, Socket.io, dotenv

## Features

- Signup/Login with JWT auth
- Create, open, edit, and delete documents
- Real-time editing via Socket.io rooms
- Live participant and cursor position updates
- Auto-save every few seconds
- Document sharing with `viewer` and `editor` roles
- Version history with restore

## Run locally
1. Backend setup:
   - Copy `backend/.env.example` to `backend/.env`
   - Update `MONGO_URI` and `JWT_SECRET`
   - Run:
     - `cd backend`
     - `npm install`
     - `npm start`

2. Frontend setup:
   - Copy `frontend/.env.example` to `frontend/.env`
   - Run:
     - `cd frontend`
     - `npm install`
     - `npm run dev`

3. Open app:
   - `http://localhost:5173`
