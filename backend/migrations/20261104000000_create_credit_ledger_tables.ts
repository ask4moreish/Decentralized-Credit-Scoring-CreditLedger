import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Users table
  const hasUsers = await knex.schema.hasTable('users');
  if (!hasUsers) {
    await knex.schema.createTable('users', (table) => {
      table.string('public_key', 56).primary();
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  // Credit score cache table
  const hasScoreCache = await knex.schema.hasTable('credit_score_cache');
  if (!hasScoreCache) {
    await knex.schema.createTable('credit_score_cache', (table) => {
      table.string('public_key', 56).primary().references('public_key').inTable('users').onDelete('CASCADE');
      table.integer('score').notNullable().defaultTo(0);
      table.integer('payment_history_score').notNullable().defaultTo(0);
      table.integer('savings_score').notNullable().defaultTo(0);
      table.integer('community_score').notNullable().defaultTo(0);
      table.integer('activity_score').notNullable().defaultTo(0);
      table.timestamp('last_updated', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  // Loans table
  const hasLoans = await knex.schema.hasTable('loans');
  if (!hasLoans) {
    await knex.schema.createTable('loans', (table) => {
      table.bigInteger('id').primary();
      table.string('borrower_public_key', 56).notNullable().references('public_key').inTable('users');
      table.decimal('amount', 30, 7).notNullable();
      table.integer('interest_rate').notNullable();
      table.integer('duration_months').notNullable();
      table.string('status', 20).notNullable().defaultTo('pending');
      table.integer('credit_score_used').notNullable().defaultTo(0);
      table.decimal('repaid_amount', 30, 7).notNullable().defaultTo(0);
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('due_date', { useTz: true });
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      table.index(['borrower_public_key'], 'idx_loans_borrower');
      table.index(['status'], 'idx_loans_status');
    });
  }

  // Vouches table
  const hasVouches = await knex.schema.hasTable('vouches');
  if (!hasVouches) {
    await knex.schema.createTable('vouches', (table) => {
      table.bigInteger('id').primary();
      table.string('voucher_key', 56).notNullable().references('public_key').inTable('users');
      table.string('vouchee_key', 56).notNullable().references('public_key').inTable('users');
      table.decimal('amount', 30, 7).notNullable();
      table.integer('trust_score').notNullable();
      table.text('reason');
      table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('expiration_date', { useTz: true });

      table.index(['voucher_key'], 'idx_vouches_voucher');
      table.index(['vouchee_key'], 'idx_vouches_vouchee');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vouches');
  await knex.schema.dropTableIfExists('loans');
  await knex.schema.dropTableIfExists('credit_score_cache');
  await knex.schema.dropTableIfExists('users');
}
