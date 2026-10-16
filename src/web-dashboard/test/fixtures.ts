// The golden files the Lambda tests write (src/lambda-transformer/test/fixtures): the dashboard is
// tested against exactly what the API produces.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncidentList, TopologyResponse } from '../src/types';

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../lambda-transformer/test/fixtures/${name}`, import.meta.url)), 'utf8')) as T;

export const topologyGolden = read<TopologyResponse>('api-topology.json');
export const incidentsGolden = read<IncidentList>('api-incidents.json');
