import type pg from 'pg';
import {
  type AccountType,
  type Direction,
  assertMoney,
  normalBalance,
} from './domain.js';
import { query, queryOne } from './db.js';
import { AppError } from './errors.js';

export type JournalLineInput = {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  direction: Direction;
  amountCents: number;
  currency: string;
};

export type JournalLineView = {
  account_code: string;
  direction: Direction;
  amount_cents: number;
  currency: string;
};

export type JournalEntryView = {
  id: string;
  description: string;
  source_type: 'payment' | 'refund';
  source_id: string;
  posted_at: string;
  lines: JournalLineView[];
};

type AccountRow = {
  id: string;
  code: string;
  name: string;
  account_type: AccountType;
  currency: string;
};

export function assertBalanced(lines: JournalLineInput[]): void {
  if (lines.length < 2) {
    throw new AppError(500, 'unbalanced_entry', 'A journal entry needs at least two lines');
  }
  let debit = 0;
  let credit = 0;
  const currency = lines[0]?.currency;
  for (const line of lines) {
    assertMoney(line.amountCents, line.currency);
    if (line.currency !== currency) {
      throw new AppError(500, 'mixed_currency', 'Journal lines in one entry must share a currency');
    }
    if (line.direction === 'debit') {
      debit += line.amountCents;
    } else {
      credit += line.amountCents;
    }
  }
  if (debit !== credit) {
    throw new AppError(500, 'unbalanced_entry', `Journal entry debits ${debit} do not equal credits ${credit}`);
  }
}

async function getOrCreateAccount(client: pg.PoolClient, line: JournalLineInput): Promise<AccountRow> {
  await client.query(
    `INSERT INTO ledger_accounts (code, name, account_type, currency)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO NOTHING`,
    [line.accountCode, line.accountName, line.accountType, line.currency],
  );
  const account = await queryOne<AccountRow>(
    client,
    'SELECT id, code, name, account_type, currency FROM ledger_accounts WHERE code = $1',
    [line.accountCode],
  );
  if (!account) {
    throw new AppError(500, 'account_missing', `Ledger account ${line.accountCode} was not created`);
  }
  if (account.currency !== line.currency || account.account_type !== line.accountType) {
    throw new AppError(500, 'account_conflict', `Ledger account ${line.accountCode} already exists with a different shape`);
  }
  return account;
}

export async function postEntry(
  client: pg.PoolClient,
  entry: {
    idempotencyKey: string;
    description: string;
    sourceType: 'payment' | 'refund';
    sourceId: string;
    lines: JournalLineInput[];
  },
): Promise<{ created: boolean; entryId: string }> {
  assertBalanced(entry.lines);
  const inserted = await queryOne<{ id: string }>(
    client,
    `INSERT INTO journal_entries (idempotency_key, description, source_type, source_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [entry.idempotencyKey, entry.description, entry.sourceType, entry.sourceId],
  );
  if (!inserted) {
    const existing = await queryOne<{ id: string }>(
      client,
      'SELECT id FROM journal_entries WHERE idempotency_key = $1',
      [entry.idempotencyKey],
    );
    if (!existing) {
      throw new AppError(500, 'journal_missing', 'Journal entry conflict did not resolve to a row');
    }
    return { created: false, entryId: existing.id };
  }

  for (const line of entry.lines) {
    const account = await getOrCreateAccount(client, line);
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, direction, amount_cents, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [inserted.id, account.id, line.direction, line.amountCents, line.currency],
    );
  }
  return { created: true, entryId: inserted.id };
}

type BalanceRow = {
  code: string;
  name: string;
  account_type: AccountType;
  currency: string;
  debit_cents: number;
  credit_cents: number;
};

export async function trialBalance(db: pg.Pool | pg.PoolClient): Promise<{
  balanced: boolean;
  total_debit_cents: number;
  total_credit_cents: number;
  accounts: Array<{
    code: string;
    name: string;
    account_type: AccountType;
    currency: string;
    debit_cents: number;
    credit_cents: number;
    balance_cents: number;
  }>;
}> {
  const rows = await query<BalanceRow>(
    db,
    `SELECT la.code, la.name, la.account_type, la.currency,
            COALESCE(SUM(CASE WHEN jl.direction = 'debit' THEN jl.amount_cents ELSE 0 END), 0)::int AS debit_cents,
            COALESCE(SUM(CASE WHEN jl.direction = 'credit' THEN jl.amount_cents ELSE 0 END), 0)::int AS credit_cents
     FROM ledger_accounts la
     LEFT JOIN journal_lines jl ON jl.account_id = la.id
     GROUP BY la.id
     ORDER BY la.code`,
  );
  let totalDebit = 0;
  let totalCredit = 0;
  const accounts = rows.map((row) => {
    totalDebit += row.debit_cents;
    totalCredit += row.credit_cents;
    return {
      code: row.code,
      name: row.name,
      account_type: row.account_type,
      currency: row.currency,
      debit_cents: row.debit_cents,
      credit_cents: row.credit_cents,
      balance_cents: normalBalance(row.account_type, row.debit_cents, row.credit_cents),
    };
  });
  return {
    balanced: totalDebit === totalCredit,
    total_debit_cents: totalDebit,
    total_credit_cents: totalCredit,
    accounts,
  };
}

export async function journalForSources(
  db: pg.Pool | pg.PoolClient,
  sources: Array<{ sourceType: 'payment' | 'refund'; sourceId: string }>,
): Promise<JournalEntryView[]> {
  if (sources.length === 0) {
    return [];
  }
  const ids = sources.map((source) => source.sourceId);
  const rows = await query<{
    id: string;
    description: string;
    source_type: 'payment' | 'refund';
    source_id: string;
    posted_at: Date;
    account_code: string;
    direction: Direction;
    amount_cents: number;
    currency: string;
  }>(
    db,
    `SELECT je.id, je.description, je.source_type, je.source_id, je.posted_at,
            la.code AS account_code, jl.direction, jl.amount_cents, jl.currency
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     JOIN ledger_accounts la ON la.id = jl.account_id
     WHERE je.source_id = ANY($1::uuid[])
     ORDER BY je.posted_at, je.id, jl.direction DESC`,
    [ids],
  );
  const grouped = new Map<string, JournalEntryView>();
  for (const row of rows) {
    const current = grouped.get(row.id);
    const line: JournalLineView = {
      account_code: row.account_code,
      direction: row.direction,
      amount_cents: row.amount_cents,
      currency: row.currency,
    };
    if (current) {
      current.lines.push(line);
      continue;
    }
    grouped.set(row.id, {
      id: row.id,
      description: row.description,
      source_type: row.source_type,
      source_id: row.source_id,
      posted_at: row.posted_at.toISOString(),
      lines: [line],
    });
  }
  return [...grouped.values()];
}
