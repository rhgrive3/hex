/*
 * query/index.js — public operational query entry point.
 *
 * Goal compilation and deterministic planning are intentionally separate modules,
 * but callers should not have to stitch them together. This facade keeps the
 * translation pure while exposing one complete compile -> search -> verify path.
 */
import { compileGoal, queryPlan, describeQuery } from '../goalc.js';
import { planAnalysisGoal, runGoalPlanner } from './planner.js';

export { compileGoal, queryPlan, describeQuery, planAnalysisGoal, runGoalPlanner };

export async function compileAndPlanGoal(text, context, opts) {
  return planAnalysisGoal(compileGoal(text), context, opts);
}
