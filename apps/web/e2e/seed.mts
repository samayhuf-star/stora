// Seeds a user, a project pointing at a local fixture repo, and an API key. Prints JSON.
import { randomBytes, scryptSync } from 'node:crypto';
import { createDb, createApiKey, createProject, createUserWithOrg } from '@stora-sh/db';
import { problemApp } from '../../../packages/agents/test/fixtures.ts';

const salt = randomBytes(16);
const passwordHash = `scrypt$${salt.toString('hex')}$${scryptSync('correct-horse', salt, 64).toString('hex')}`;
const { db, close } = await createDb();
const email = `e2e+${Date.now()}@example.com`;
const { org } = await createUserWithOrg(db, { email, name: 'E2E', passwordHash, orgName: 'E2E Org' });
const project = await createProject(db, org.id, { name: 'Problem App', repoUrl: problemApp(), platform: 'both' });
const k = await createApiKey(db, org.id, 'e2e');
console.log(JSON.stringify({ email, password: 'correct-horse', projectId: project.id, apiKey: k.key }));
await close();
