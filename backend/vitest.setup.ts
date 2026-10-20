import 'dotenv/config';

// Tests must never touch the development database: point Prisma at a dedicated *_test database.
const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
if (!url) throw new Error('DATABASE_URL is not set');
process.env.DATABASE_URL = url;

// Tests must never send real email: the Resend key is blanked unless a test sets one on purpose.
process.env.RESEND_API_KEY = '';

// Tests must never call a real LLM provider: forced to the deterministic engine unless a test
// sets USE_REAL_LLM/LLM_PROVIDER itself (several already do, and restore process.env afterward).
process.env.USE_REAL_LLM = 'false';
