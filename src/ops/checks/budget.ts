/** Today's LLM spend against the daily cap (RATE.BUDGET at the cap). */
import { appDb } from './database';
import { bad, ok, type Check } from './types';

export const checkBudget: Check = async (c) => {
  const rows = await c.withDb(
    appDb(c),
    (q) =>
      q(
        `SELECT b.daily_limit_usd::float AS limit_usd, b.alert_at_pct, b.hard_stop, coalesce(d.spent_usd, 0)::float AS spent_usd
           FROM llm_budgets b JOIN users u ON u.id = b.owner_user_id
           LEFT JOIN llm_budget_days d ON d.budget_id = b.id AND d.day = (now() AT TIME ZONE u.timezone)::date
          WHERE b.scope = 'total' ORDER BY b.effective_from DESC LIMIT 1`,
      ),
  ).catch(() => null);
  if (rows === null || rows.length === 0) return bad('skip', 'budget', 'LLM budget (today)', 'no budget data yet (database or tables not ready)');
  const r = rows[0]!;
  const limit = Number(r.limit_usd);
  const spent = Number(r.spent_usd);
  const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
  const data = { spent_usd: spent, limit_usd: limit, pct };
  const detail = `$${spent.toFixed(2)} of $${limit.toFixed(2)} (${pct}%)`;
  if (pct >= 100) return bad(r.hard_stop ? 'fail' : 'warn', 'budget', 'LLM budget (today)', `${detail}, cap reached${r.hard_stop ? ': scanning paused' : ''}`, 'raise the cap on Health, or wait for tomorrow', data, { code: 'RATE.BUDGET' });
  if (pct >= Number(r.alert_at_pct ?? 80)) return bad('warn', 'budget', 'LLM budget (today)', detail, 'watch spend on Health', data);
  return ok('budget', 'LLM budget (today)', detail, data);
};
