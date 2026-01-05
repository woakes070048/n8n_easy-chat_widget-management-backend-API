import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { chat_session_status, message_role, Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import logger from '../utils/logger';
import { sendToN8n, type N8nHistoryEntry } from './n8nService';

type ChatMessageDto = {
  id: string;
  sender: message_role;
  content: string;
  createdAt: string;
};

type IncomingMessagePayload = {
  sessionId?: string;
  content: string;
  metadata?: Record<string, unknown>;
};

type HeartbeatPayload = {
  sessionId?: string;
};

type EndSessionPayload = {
  sessionId?: string;
};

type ClientToServerEvents = {
  message: (payload: IncomingMessagePayload) => void;
  heartbeat: (payload: HeartbeatPayload) => void;
  endSession: (payload: EndSessionPayload) => void;
  end_chat: (payload: EndSessionPayload) => void; // React frontend uses this event name
};

type ServerToClientEvents = {
  session: (payload: { sessionId: string; visitorId: string; status: chat_session_status }) => void;
  history: (payload: { messages: ChatMessageDto[] }) => void; // React frontend expects { messages: [] }
  message: (payload: ChatMessageDto) => void;
  status: (payload: { status: chat_session_status }) => void;
  error: (payload: { message: string }) => void;
  sessionClosed: (payload: { sessionId: string; message: string }) => void;
};

type InterServerEvents = Record<string, never>;
type SocketData = {
  sessionId?: string;
  visitorId?: string;
};

export function createSocketManager(httpServer: HttpServer) {
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      cors: {
        origin: env.corsOrigins.length ? env.corsOrigins : '*',
        credentials: true,
      },
      // OPTIMIZATION: Faster handshake for instant session emission
      pingTimeout: 30000,
      pingInterval: 25000,
    }
  );

  io.on('connection', (socket) => {
    // Debug: log ALL events from client
    socket.onAny((eventName, ...args) => {
      logger.info(`📥 [SERVER] Received event "${eventName}": ${JSON.stringify(args)}`);
    });
    
    void handleConnection(io, socket);
  });

  return io;
}

async function handleConnection(
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
) {
  const visitorId =
    (socket.handshake.auth?.visitorId as string | undefined) ||
    (socket.handshake.query.visitorId as string | undefined) ||
    uuid();

  const requestedSessionId =
    (socket.handshake.auth?.sessionId as string | undefined) ||
    (socket.handshake.query.sessionId as string | undefined);

  logger.info(`🔌 Connection attempt: visitor=${visitorId}, requestedSession=${requestedSessionId || 'none'}`);

  try {
    // CRITICAL: Create session BEFORE registering handlers for instant response
    const session = await ensureSession(visitorId, requestedSessionId);
    
    socket.data.sessionId = session.id;
    socket.data.visitorId = visitorId;
    socket.join(session.id);

    logger.info(`✅ Session ready: ${session.id} (status=${session.status})`);

    // Register handlers BEFORE emitting events to avoid race condition
    registerSocketEvents(io, socket);

    // INSTANT RESPONSE: Emit session immediately
    socket.emit('session', {
      sessionId: session.id,
      visitorId,
      status: session.status,
    });
    logger.info(`📤 Emitted session event to client: ${session.id}`);

    // Send history if exists (wrap in object for React frontend)
    const history = await getHistory(session.id);
    if (history.length) {
      socket.emit('history', { messages: history }); // React expects { messages: [] }
      logger.info(`📜 Sent ${history.length} history messages`);
    } else {
      logger.info(`📜 No history for new session ${session.id}`);
    }

    await prisma.chatSession.update({
      where: { id: session.id },
      data: { last_active_at: new Date(), status: chat_session_status.ACTIVE },
    });
  } catch (error) {
    // Log to both Winston AND console (so Render shows it)
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : '';
    console.error('❌ Socket connection failed:', errMsg);
    console.error('Stack:', errStack);
    logger.error('Socket connection failed', { message: errMsg, stack: errStack });
    socket.emit('error', { message: 'Unable to start chat session. Please refresh and try again.' });
    socket.disconnect(true);
  }
}

function registerSocketEvents(
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
) {
  socket.on('message', async (payload) => {
    const sessionId = payload.sessionId ?? socket.data.sessionId;
    
    // CRITICAL: Validate session exists before processing
    if (!sessionId) {
      logger.warn('❌ No sessionId for message event');
      socket.emit('error', { message: 'Session not established yet. Please wait.' });
      return;
    }

    const content = payload.content?.trim();
    if (!content) {
      logger.warn('⚠️ Empty message content');
      return;
    }

    logger.info(`📥 Message received: session=${sessionId}, content="${content.substring(0, 50)}..."`);

    try {
      // CRITICAL: Verify session is still valid and not closed
      const session = await prisma.chatSession.findUnique({ 
        where: { id: sessionId },
        select: { id: true, status: true }
      });
      
      if (!session) {
        logger.warn(`❌ Session ${sessionId} not found`);
        socket.emit('error', { message: 'Session expired. Please refresh the page.' });
        socket.emit('sessionClosed', { 
          sessionId, 
          message: 'Session not found. Starting new session...' 
        });
        return;
      }
      
      if (session.status === chat_session_status.CLOSED) {
        logger.warn(`❌ Attempt to message closed session ${sessionId}`);
        socket.emit('sessionClosed', { 
          sessionId, 
          message: 'Session was closed. Please start a new chat.' 
        });
        return;
      }

      const userMessage = await prisma.chatMessage.create({
        data: {
          session_id: sessionId,
          role: message_role.USER,
          content,
        },
      });

      // Echo user message to client (for multi-device sync)
      io.to(sessionId).emit('message', mapMessage(userMessage));
      logger.info(`📤 User message echoed to client`);

      // Update session activity
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { last_active_at: new Date(), status: chat_session_status.ACTIVE },
      });

      // Get AI response from n8n
      logger.info(`🤖 Calling n8n webhook...`);
      const historyForBrain = await getHistory(sessionId, 50);
      const aiReply = await sendToN8n({
        sessionId,
        message: content,
        history: historyForBrain.map<N8nHistoryEntry>((m) => ({
          sender: m.sender,
          content: m.content,
          createdAt: m.createdAt,
        })),
        metadata: payload.metadata,
      });

      // Save and send AI message
      const aiMessage = await prisma.chatMessage.create({
        data: {
          session_id: sessionId,
          role: message_role.BOT,
          content: aiReply,
        },
      });

      io.to(sessionId).emit('message', mapMessage(aiMessage));
      logger.info(`📤 AI response sent: "${aiReply.substring(0, 50)}..."`);
    } catch (error) {
      logger.error('Error handling message event', error);
      socket.emit('error', { message: 'Unable to send message right now. Please try again.' });
    }
  });

  socket.on('heartbeat', async (payload) => {
    const sessionId = payload.sessionId ?? socket.data.sessionId;
    if (!sessionId) return;

    try {
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { last_active_at: new Date(), status: chat_session_status.ACTIVE },
      });
    } catch (error) {
      logger.warn('Failed to record heartbeat', error as Error);
    }
  });

  // WordPress widget uses 'endSession' event
  socket.on('endSession', async (payload) => {
    await handleEndSession(socket, payload);
  });

  // React frontend uses 'end_chat' event
  socket.on('end_chat', async (payload) => {
    await handleEndSession(socket, payload);
  });
}

// UNIFIED END SESSION LOGIC - Handles both WordPress and React frontends
async function handleEndSession(
  socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  payload: EndSessionPayload
) {
  const sessionId = payload.sessionId ?? socket.data.sessionId;
  
  if (!sessionId) {
    logger.warn('⚠️ endSession called without sessionId');
    return;
  }

  try {
    logger.info(`🔚 Ending session ${sessionId} by user request`);

    // 1. Close session in database
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { 
        status: chat_session_status.CLOSED,
        last_active_at: new Date()
      },
    });

    // 2. Add system message
    await prisma.chatMessage.create({
      data: {
        session_id: sessionId,
        role: message_role.SYSTEM,
        content: 'Chat session ended by user.',
      },
    });

    // 3. Notify client
    socket.emit('sessionClosed', {
      sessionId,
      message: 'Session ended successfully. You can start a new conversation.',
    });

    // 4. Clean up socket
    socket.leave(sessionId);
    socket.data.sessionId = undefined;

    logger.info(`✅ Session ${sessionId} closed successfully`);

  } catch (error) {
    logger.error('Error ending session', error);
    socket.emit('error', { message: 'Failed to end session. Please try again.' });
  }
}

// OPTIMIZED: Single database query with proper filtering and detailed logging
async function ensureSession(visitorId: string, requestedSessionId?: string) {
  // If requested session exists and not closed, reuse it
  if (requestedSessionId) {
    const session = await prisma.chatSession.findUnique({ 
      where: { id: requestedSessionId },
      select: { id: true, visitor_id: true, status: true, created_at: true, last_active_at: true, metadata: true }
    });
    
    if (session && session.status !== chat_session_status.CLOSED) {
      logger.info(`♻️ Reusing existing session: ${session.id}`);
      return session;
    } else if (session) {
      logger.info(`🚫 Requested session ${requestedSessionId} is CLOSED, creating new one`);
    }
  }

  // Check for any non-closed session for this visitor
  const existing = await prisma.chatSession.findFirst({
    where: {
      visitor_id: visitorId,
      status: { not: chat_session_status.CLOSED },
    },
    orderBy: { created_at: 'desc' },
  });

  if (existing) {
    logger.info(`♻️ Found existing active session for visitor: ${existing.id}`);
    return existing;
  }

  // Create new session
  const newSession = await prisma.chatSession.create({
    data: {
      visitor_id: visitorId,
      status: chat_session_status.ACTIVE,
    },
  });

  logger.info(`✨ Created new session: ${newSession.id}`);
  return newSession;
}

async function getHistory(sessionId: string, limit = 100): Promise<ChatMessageDto[]> {
  const messages = await prisma.chatMessage.findMany({
    where: { session_id: sessionId },
    orderBy: { created_at: 'asc' },
    take: limit,
  });

  return messages.map(mapMessage);
}

function mapMessage(message: { id: string; role: message_role; content: string; created_at: Date }): ChatMessageDto {
  return {
    id: message.id,
    sender: message.role,
    content: message.content,
    createdAt: message.created_at.toISOString(),
  };
}
