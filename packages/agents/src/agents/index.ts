import type { AgentDefinition, AgentName } from '../types.js';
import { scoutAgent } from './scout.js';
import { complianceAgent } from './compliance.js';
import { asoAgent } from './aso.js';
import { listingAgent } from './listing.js';
import { screenshotsAgent } from './screenshots.js';
import { criticAgent } from './critic.js';

export const AGENTS: Record<AgentName, AgentDefinition<any>> = {
  scout: scoutAgent,
  compliance: complianceAgent,
  aso: asoAgent,
  listing: listingAgent,
  screenshots: screenshotsAgent,
  critic: criticAgent,
};

export { scoutAgent, complianceAgent, asoAgent, listingAgent, screenshotsAgent, criticAgent };
