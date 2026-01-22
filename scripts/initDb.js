import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { withClient } from '../db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const run = async () => {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = await fs.readFile(schemaPath, 'utf-8');

  await withClient(async (client) => {
    await client.query(sql);
  });

  console.log('Database initialized');
};

run().catch((error) => {
  console.error('Failed to initialize database', error);
  process.exit(1);
});
