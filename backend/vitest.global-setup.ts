import 'dotenv/config';
import { execSync } from 'child_process';

/** Creates (if needed) and migrates the *_test database once before the whole test run. */
export default function setup() {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
  if (!url) throw new Error('DATABASE_URL is not set');
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
