// LOCAL only (ENVIRONMENT=local): gives each test account lots of PRNs and
// PERNs awaiting acceptance in the epr-local-environment PRN database, and puts
// the database back afterwards. Before the run it records the accounts' own
// notes and inserts generated ones; after it, it deletes the generated notes
// and every status change made to the accounts' own notes.
//
// In CDP the PRN common backend is the Azure stub, which owns its data; this
// module does nothing there.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'

const CONTAINER = process.env.LOCAL_SQL_CONTAINER ?? 'epr-local-environment-sqledge-1'
const DATABASE = 'EprPrnBackend'
// Generated notes start with this, so a run that stopped before restoring is
// cleaned up by the next one.
const NUMBER_PREFIX = 'PF'

export function localPrnDataEnabled() {
  return process.env.ENVIRONMENT === 'local' && process.env.LOCAL_PRN_SEED !== 'false'
}

export function prnsPerAccount() {
  const raw = process.env.LOCAL_PRNS_PER_ACCOUNT ?? '300'
  const count = Number(raw)
  if (!Number.isInteger(count) || count < 1 || count > 9999) {
    throw new Error(`LOCAL_PRNS_PER_ACCOUNT must be an integer from 1 to 9999, got '${raw}'`)
  }
  return count
}

function guid(value) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`Not an organisation ID: ${value}`)
  }
  return value
}

// The SA password is read inside the container, so it never reaches this process.
function sql(statement) {
  const result = spawnSync(
    'docker',
    [
      'exec', '-i', CONTAINER, 'sh', '-c',
      `/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d ${DATABASE} -h -1 -W -s "|" -i /dev/stdin`
    ],
    { input: `SET NOCOUNT ON;\n${statement}\nGO\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )

  if (result.status !== 0) {
    throw new Error(`sqlcmd failed in ${CONTAINER}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`)
  }

  return result.stdout.trim()
}

// Rows as objects, from a pipe-separated SELECT of `columns` (NULL stays null).
function readRows(statement, columns) {
  const output = sql(statement)
  if (!output) return []

  return output.split('\n').map((line) => {
    const values = line.trim().split('|')
    return Object.fromEntries(columns.map((column, i) => [column, values[i] === 'NULL' ? null : values[i]]))
  })
}

function deleteGenerated(organisationIds) {
  const ids = organisationIds.map((id) => `'${guid(id)}'`).join(',')
  sql(`
DELETE h FROM PrnStatusHistory h JOIN Prn p ON p.Id = h.PrnIdFk
  WHERE p.OrganisationId IN (${ids}) AND p.PrnNumber LIKE '${NUMBER_PREFIX}%';
DELETE FROM Prn WHERE OrganisationId IN (${ids}) AND PrnNumber LIKE '${NUMBER_PREFIX}%';`)
}

function insertGenerated(organisationId, tag, count, year) {
  const id = guid(organisationId)
  sql(`
DECLARE @name nvarchar(160) = COALESCE(
  (SELECT TOP 1 OrganisationName FROM Prn WHERE OrganisationId = '${id}' AND PrnNumber NOT LIKE '${NUMBER_PREFIX}%'),
  'Performance test organisation');
DECLARE @latest datetime2 = DATEADD(hour, -1, SYSUTCDATETIME());
DECLARE @earliest datetime2 = DATEFROMPARTS(${year}, 2, 1);
WITH n AS (
  SELECT TOP (${count}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO Prn (ExternalId, PrnNumber, OrganisationId, OrganisationName, ProducerAgency,
  ReprocessorExporterAgency, PrnStatusId, TonnageValue, MaterialName, IssuerNotes, IssuerReference,
  PrnSignatory, PrnSignatoryPosition, IssueDate, ProcessToBeUsed, DecemberWaste, IssuedByOrg,
  AccreditationNumber, ReprocessingSite, AccreditationYear, ObligationYear, PackagingProducer,
  CreatedOn, LastUpdatedBy, LastUpdatedDate, IsExport)
SELECT NEWID(),
  CONCAT('${NUMBER_PREFIX}', IIF(i % 3 = 0, 'EX', 'ER'), RIGHT('${year}', 2), '${tag}', RIGHT(CONCAT('0000', i), 4)),
  '${id}', @name, 'EA',
  CHOOSE(i % 4 + 1, 'EA', 'NRW', 'SEPA', 'NIEA'),
  4,
  5 + (i * 37) % 495,
  CHOOSE(i % 7 + 1, 'Aluminium', 'Glass Other', 'Glass Re-melt', 'Paper/board', 'Plastic', 'Steel', 'Wood'),
  IIF(i % 4 = 0, 'Generated for performance testing.', NULL),
  'PERF',
  'Perf Signatory', 'Director',
  IIF(DATEADD(day, -(i % 200), @latest) < @earliest, @earliest, DATEADD(day, -(i % 200), @latest)),
  CONCAT('R', 3 + i % 3),
  CAST(IIF(i % 10 = 5, 1, 0) AS bit),
  CHOOSE(i % 6 + 1, 'Green Reprocessing Ltd', 'Northern Recycling Plc', 'Severn Materials Recovery',
    'Highland Glass Works', 'Coastal Export Services', 'Midlands Metal Recyclers'),
  CONCAT('ACC', '${tag}', RIGHT(CONCAT('0000', i), 4)),
  IIF(i % 3 = 0, NULL, 'Unit 1, Industrial Estate'),
  '${year}', '${year}', 'Packaging Producer',
  @latest, '00000000-0000-0000-0000-000000000000', @latest,
  CAST(IIF(i % 3 = 0, 1, 0) AS bit)
FROM n;`)
}

/**
 * Records the accounts' own notes to `snapshotPath`, then inserts `count`
 * generated notes per account (a third PERNs, every material, a tenth
 * December waste), all awaiting acceptance for `year`.
 */
export async function prepareLocalPrns(accounts, { count, year, snapshotPath }) {
  const organisationIds = accounts.map((account) => account.organisationId)
  const ids = organisationIds.map((id) => `'${guid(id)}'`).join(',')

  deleteGenerated(organisationIds)

  const snapshot = {
    organisationIds,
    prns: readRows(
      `SELECT Id, PrnStatusId, StatusUpdatedOn, ObligationYear, LastUpdatedBy, LastUpdatedDate
FROM Prn WHERE OrganisationId IN (${ids}) ORDER BY Id;`,
      ['Id', 'PrnStatusId', 'StatusUpdatedOn', 'ObligationYear', 'LastUpdatedBy', 'LastUpdatedDate']
    ),
    lastStatusHistoryId: Number(sql('SELECT COALESCE(MAX(Id), 0) FROM PrnStatusHistory;').trim())
  }
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2))

  for (const [index, account] of accounts.entries()) {
    insertGenerated(account.organisationId, account.tag ?? String.fromCharCode(65 + index), count, year)
  }

  return snapshot
}

/** Deletes the generated notes and puts the accounts' own notes back as recorded. */
export async function restoreLocalPrns(snapshotPath) {
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'))
  const ids = snapshot.organisationIds.map((id) => `'${guid(id)}'`).join(',')

  deleteGenerated(snapshot.organisationIds)

  const value = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`)
  const updates = snapshot.prns.map(
    (prn) =>
      `UPDATE Prn SET PrnStatusId = ${Number(prn.PrnStatusId)}, StatusUpdatedOn = ${value(prn.StatusUpdatedOn)}, ` +
      `ObligationYear = ${value(prn.ObligationYear)}, LastUpdatedBy = ${value(prn.LastUpdatedBy)}, ` +
      `LastUpdatedDate = ${value(prn.LastUpdatedDate)} WHERE Id = ${Number(prn.Id)};`
  )

  sql(`
BEGIN TRANSACTION;
DELETE h FROM PrnStatusHistory h JOIN Prn p ON p.Id = h.PrnIdFk
  WHERE p.OrganisationId IN (${ids}) AND h.Id > ${Number(snapshot.lastStatusHistoryId)};
${updates.join('\n')}
COMMIT;`)

  return snapshot.prns.length
}
