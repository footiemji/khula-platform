// South African banks and their universal branch codes — verified against
// multiple independent sources. Used to auto-fill the branch code once a
// borrower picks their bank, so they only ever type their account number,
// not a branch code they may not know offhand.
//
// Shared between server (for WhatsApp's text-based bank matching) and
// frontend (for the dropdown) — this file is plain data with no
// dependencies, safe to load in either place.

const SA_BANKS = [
  { name: 'Absa', branchCode: '632005' },
  { name: 'African Bank', branchCode: '430000' },
  { name: 'Bidvest Bank', branchCode: '462005' },
  { name: 'Capitec', branchCode: '470010' },
  { name: 'Discovery Bank', branchCode: '679000' },
  { name: 'FNB', branchCode: '250655' },
  { name: 'Investec', branchCode: '580105' },
  { name: 'Nedbank', branchCode: '198765' },
  { name: 'Standard Bank', branchCode: '051001' },
  { name: 'TymeBank', branchCode: '678910' },
  { name: 'Other', branchCode: null }, // borrower/agent types both name and branch code manually
];

// Fuzzy-matches free text (e.g. what someone types over WhatsApp) against
// the known bank list — handles common variations like "fnb", "std bank",
// "nedbank ltd" without requiring an exact match.
function matchBankName(text) {
  const normalized = String(text || '').toLowerCase().trim();
  if (!normalized) return null;

  const aliases = {
    fnb: 'FNB',
    'first national bank': 'FNB',
    'std bank': 'Standard Bank',
    standard: 'Standard Bank',
    absa: 'Absa',
    capitec: 'Capitec',
    nedbank: 'Nedbank',
    investec: 'Investec',
    'african bank': 'African Bank',
    discovery: 'Discovery Bank',
    tyme: 'TymeBank',
    tymebank: 'TymeBank',
    bidvest: 'Bidvest Bank',
  };

  for (const [alias, canonical] of Object.entries(aliases)) {
    if (normalized.includes(alias)) {
      return SA_BANKS.find((b) => b.name === canonical) || null;
    }
  }

  const direct = SA_BANKS.find((b) => normalized.includes(b.name.toLowerCase()));
  return direct || null;
}

module.exports = { SA_BANKS, matchBankName };
