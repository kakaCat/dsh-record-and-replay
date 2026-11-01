import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export default async function globalSetup(): Promise<void> {
  await execFileAsync('pnpm', ['run', 'build:client'], { cwd: process.cwd() })
}
