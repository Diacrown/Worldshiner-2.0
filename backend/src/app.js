import express from 'express';
import cors from 'cors';
import path from 'node:path';
import 'dotenv/config';

import { authRouter } from './routes/auth.routes.js';
import { jobsRouter } from './routes/jobs.routes.js';
import { officesRouter } from './routes/offices.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { issuesRouter } from './routes/issues.routes.js';
import { chatRouter } from './routes/chat.routes.js';
import { uploadsRouter } from './routes/uploads.routes.js';
import { invitesRouter } from './routes/invites.routes.js';
import { jobItemsRouter } from './routes/jobItems.routes.js';
import { slaRouter } from './routes/sla.routes.js';
import { reportsRouter } from './routes/reports.routes.js';
import { importRouter } from './routes/import.routes.js';
import { gmailRouter } from './routes/gmail.routes.js';
import { officeChatRouter } from './routes/officeChat.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json({ limit: '8mb' })); // headroom for base64 image uploads (see uploads.routes.js)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'worldshiner2-backend' }));

app.use('/api/auth', authRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/offices', officesRouter);
app.use('/api/users', usersRouter);
app.use('/api', issuesRouter);   // mounts /api/jobs/:jobId/issues and /api/issues/:id
app.use('/api', chatRouter);     // mounts /api/jobs/:jobId/chat and /api/chat/unread-counts
app.use('/api', jobItemsRouter); // mounts /api/jobs/:jobId/design-entries and /api/jobs/:jobId/client-items
app.use('/api/uploads', uploadsRouter);
app.use('/api/invite-codes', invitesRouter);
app.use('/api/sla', slaRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/import', importRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/office-chat', officeChatRouter);

app.use(notFoundHandler);
app.use(errorHandler);
