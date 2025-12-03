# PixelPunch Chat Middleware

A backend chat middleware for WordPress and legacy sites, enabling real-time chat widgets powered by n8n agents. This backend manages chat sessions, message history, and integrates with n8n workflows for AI/automation.

## Features
- Real-time chat via Socket.IO
- Session and message history management (Postgres/Supabase)
- n8n webhook integration for bot/agent responses
- Designed for easy drop-in on WordPress and legacy sites
- No changes required to existing site code
- REST API for session management
- Health check endpoint (`/health`)

## Folder Structure
```
├── src/                # Backend source code (TypeScript)
│   ├── server.ts       # Main server entry
│   ├── config/         # Environment config
│   ├── lib/            # Prisma client
│   ├── services/       # Socket, n8n, cleanup jobs
│   └── utils/          # Logger
├── prisma/             # Prisma schema
├── public/             # Static assets
├── wordpress site code to deploy on wordpress global header/
│   └── header-widget.html  # Chat widget for WordPress
├── .env.example        # Example environment variables
├── render.yaml         # Render deployment blueprint
├── package.json        # Project metadata & scripts
├── tsconfig.json       # TypeScript config
└── README.md           # This file
```

## Getting Started

1. **Install dependencies:**
   ```sh
   npm install
   ```
2. **Configure environment:**
   - Copy `.env.example` to `.env` and fill in your values
3. **Generate Prisma client:**
   ```sh
   npm run build
   ```
4. **Start development server:**
   ```sh
   npm run dev
   ```

## Deployment (Render)
- See `render.yaml` for one-click deploy
- Set environment variables in Render dashboard (see `.env.example`)
- Update your WordPress widget's `MIDDLEWARE_URL` to your Render app URL

## API Endpoints
- `GET /health` — Health check
- `GET /api/sessions` — List sessions
- `POST /api/sessions` — Create session
- `GET /api/sessions/:id` — Get session by ID

## License
MIT
