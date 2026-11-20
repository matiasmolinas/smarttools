// The gallery: the 3D-assembly scenarios first, then the flat-sheet ones.
import { ASSEMBLY_SCENARIOS, assemblyHero } from "./assembly-scenarios.ts";
import { SCENARIOS_FLAT, PROJECT_INFO, type Scenario } from "./scenarios.ts";

export const SCENARIOS: Scenario[] = [...ASSEMBLY_SCENARIOS, ...SCENARIOS_FLAT];
export const HERO: Scenario = assemblyHero;
export { PROJECT_INFO };
export type { Scenario };
