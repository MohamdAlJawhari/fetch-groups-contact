import { parseArgs } from 'node:util';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { prisma } from '../database/prisma.js';
import { BcryptPasswordHasher } from '../modules/auth/password.hasher.js';
import { emailSchema, newPasswordSchema, PASSWORD_REQUIREMENTS } from '../modules/auth/auth.validation.js';

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: process.stdin, output: mutedOutput, terminal: true });
  try {
    process.stdout.write('Initial password (hidden): ');
    const password = await prompt.question('');
    process.stdout.write('\nConfirm password (hidden): ');
    const confirmation = await prompt.question('');
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match.');
    return password;
  } finally { prompt.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' } }, strict: true });
  const email = emailSchema.safeParse(values.email);
  if (!email.success) throw new Error('Usage: npm run admin:create -- --email admin@example.com');
  const password = newPasswordSchema.safeParse(await readPassword());
  if (!password.success) throw new Error(PASSWORD_REQUIREMENTS);
  const passwordHash = await new BcryptPasswordHasher().hash(password.data);
  await prisma.$transaction(async (tx) => {
    if (await tx.user.count({ where: { role: 'admin' } })) {
      throw new Error('An admin already exists. This command only creates the first admin.');
    }
    if (await tx.user.findUnique({ where: { email: email.data } })) {
      throw new Error('That email is already in use; no existing account was changed.');
    }
    await tx.user.create({ data: { email: email.data, passwordHash, role: 'admin', mustChangePassword: true } });
  }, { isolationLevel: 'Serializable' });
  console.log('First admin created. Change the temporary password after login.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error && error.constructor === Error ? error.message : 'Could not create admin. Check database access and whether the admin already exists.';
  console.error(message);
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
