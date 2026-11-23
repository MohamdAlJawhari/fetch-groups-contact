import 'dotenv/config';
import { parseEnvironment } from './env.schema.js';

export const config = parseEnvironment(process.env);
