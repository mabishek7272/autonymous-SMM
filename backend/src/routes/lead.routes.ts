import { Router } from 'express';
import {
  createLead,
  getLeads,
  getLeadById,
  updateLeadStatus,
  qualifyLead,
  deleteLead,
} from '../controllers/lead.controller';
import { importLeads } from '../controllers/lead-import.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { rolesWith } from '../utils/permissions';
import { asyncHandler } from '../utils/async-handler';

const router = Router();

// All lead routes require authentication
router.use(authenticate, authorize(...rolesWith('leads:manage')));

/** POST /api/v1/leads/import — bulk-load the enquiry sheet (dryRun supported) */
router.post('/import', asyncHandler(importLeads));

/** GET /api/v1/leads — List all leads (with optional status filter) */
router.get('/', asyncHandler(getLeads));

/** GET /api/v1/leads/:id — Get a single lead */
router.get('/:id', asyncHandler(getLeadById));

/** POST /api/v1/leads — Create a new lead (used by webhook handler or manual entry) */
router.post('/', asyncHandler(createLead));

/** PATCH /api/v1/leads/:id/status — Update lead status */
router.patch('/:id/status', asyncHandler(updateLeadStatus));

/**
 * POST /api/v1/leads/:id/qualify
 * AI Tool endpoint: The Admissions AI calls this to mark a lead as qualified
 * and fill in captured details.
 */
router.post('/:id/qualify', asyncHandler(qualifyLead));

/** DELETE /api/v1/leads/:id — Soft-delete / mark as lost */
router.delete('/:id', asyncHandler(deleteLead));

export default router;
