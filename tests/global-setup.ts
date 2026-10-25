import { execSync } from 'node:child_process'
import path from 'node:path'
import dotenv from 'dotenv'

// Applies migrations to the dedicated TEST database before the suite runs.
export default function setup() {
  dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true })
  const url = process.env.TEST_DATABASE_URL
  if (!url || !/test/i.test(url)) throw new Error('TEST_DATABASE_URL must be set and point to a database with "test" in its name')
  execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' })
}
