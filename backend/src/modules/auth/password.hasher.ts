import bcrypt from 'bcrypt';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export class BcryptPasswordHasher implements PasswordHasher {
  constructor(private readonly rounds = 12) {}
  async hash(password: string) {
    if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('Password exceeds 72 bytes');
    return bcrypt.hash(password, this.rounds);
  }
  async verify(password: string, hash: string) {
    if (Buffer.byteLength(password, 'utf8') > 72) return false;
    return bcrypt.compare(password, hash);
  }
}
