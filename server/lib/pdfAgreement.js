// Generates a pre-agreement statement PDF — the plain-language summary of
// loan terms a borrower should be able to read before signing. Modelled on
// the spirit of NCA pre-agreement disclosure (amount, cost, term, total
// repayable, rights) but the exact required wording/format must be
// confirmed with your compliance officer before this replaces a real
// legal document — see docs/COMPLIANCE.md.

const PDFDocument = require('pdfkit');

const FOREST = '#2C5F2D';
const GOLD = '#C89B2A';
const INK = '#16241A';
const INK_SOFT = '#4B5B4F';

function fmtZAR(n) {
  return `R${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Streams a pre-agreement statement PDF for the given application directly
 * to an HTTP response.
 * @param {import('http').ServerResponse} res
 * @param {object} app - the stored application record
 * @param {number} reconsiderationDays - length of the reconsideration window
 */
function streamPreAgreementPDF(res, app, reconsiderationDays = 5) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${app.reference}-pre-agreement.pdf"`);
  doc.pipe(res);

  // Header band
  doc.rect(0, 0, doc.page.width, 90).fill(FOREST);
  doc.fillColor('white').fontSize(20).font('Helvetica-Bold').text('Khula Financial Services', 50, 28);
  doc.fontSize(10).font('Helvetica').fillColor(GOLD).text('GROW · THRIVE · RISE', 50, 54, { characterSpacing: 1.2 });
  doc.fillColor('white').fontSize(9).text(`Pre-agreement statement · ${app.reference}`, 50, 68);

  doc.moveDown(4);
  doc.fillColor(INK).fontSize(15).font('Helvetica-Bold').text('Pre-agreement statement and quotation', 50, 110);
  doc.fontSize(9).font('Helvetica').fillColor(INK_SOFT).text(
    'This document summarises the terms of the credit being offered to you, in line with the disclosure principles of the National Credit Act. Please read it carefully before signing. It is not yet a binding agreement.',
    { width: 495 }
  );

  doc.moveDown(1.2);
  section(doc, 'Your details');
  kv(doc, [
    ['Full name', app.fullName],
    ['Phone number', app.phoneNumber],
    ['Reference', app.reference],
    ['Application date', new Date(app.createdAt).toLocaleDateString('en-ZA')],
  ]);

  doc.moveDown(0.6);
  section(doc, 'Payout details');
  kv(doc, [
    ['Account holder', app.bankAccountHolder],
    ['Bank', app.bankName],
    ['Account number', app.accountNumber ? `****${String(app.accountNumber).slice(-4)}` : '—'],
  ]);
  doc.fontSize(8).font('Helvetica').fillColor(INK_SOFT).text(
    'Your loan will be paid into this account. It must be held in your own name — Khula does not pay out to third-party accounts.',
    { width: 495 }
  );

  doc.moveDown(0.6);
  section(doc, 'Cost of credit');
  const q = app.affordability?.quotation;
  if (q) {
    kv(doc, [
      ['Principal amount', fmtZAR(app.requestedAmount)],
      ['Term', `${app.termMonths} months`],
      ['Interest rate', `${(q.monthlyInterestRate * 100).toFixed(1)}% per month`],
      ['Initiation fee (once-off)', fmtZAR(q.initiationFee)],
      ['Monthly service fee', fmtZAR(q.monthlyServiceFee)],
      ['Credit life insurance (first month)', `${fmtZAR(q.schedule[0].insurancePremium)} — reduces as you repay`],
      ['First month\'s total instalment', fmtZAR(q.firstMonthInstalment)],
    ]);
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(FOREST).text(`Total interest over the term: ${fmtZAR(q.totalInterest)}`, 50);
    doc.text(`Total fees over the term: ${fmtZAR(q.initiationFee + q.totalServiceFees)}`, 50);
    doc.text(`Total insurance over the term: ${fmtZAR(q.totalInsurance)}`, 50);
    doc.fontSize(11).text(`TOTAL COST OF CREDIT: ${fmtZAR(q.totalCostOfCredit)}`, 50);
    doc.fontSize(12).text(`TOTAL YOU WILL REPAY: ${fmtZAR(q.totalRepayable)}`, 50);
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica').fillColor(INK_SOFT).text(
      'Interest and fees are charged at or below the maximum rates permitted by the National Credit Act for short-term credit. Credit life insurance is charged on your outstanding balance and reduces each month as you repay, so the total insurance figure above is the sum across the full term, not a flat monthly amount.',
      { width: 495 }
    );
    if (q.aboveShortTermCreditCeiling) {
      doc.moveDown(0.3);
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#B23A2E').text(
        `⚠ This loan amount is above R${q.shortTermCreditCeiling}, which is outside the short-term credit bracket these figures are based on. Confirm the correct interest/fee formula with your compliance officer before relying on this quote.`,
        { width: 495 }
      );
    }
  } else {
    kv(doc, [
      ['Principal amount', fmtZAR(app.requestedAmount)],
      ['Term', `${app.termMonths} months`],
      ['Estimated monthly instalment', fmtZAR(app.affordability?.proposedInstalment)],
    ]);
  }
  doc.moveDown(0.3);
  doc.fontSize(8).font('Helvetica').fillColor(INK_SOFT).text(
    'Figures are based on the information you provided and Khula\'s pricing at the time of application. Your final signed agreement is the authoritative record of the exact interest rate, fees, and total cost of credit.',
    { width: 495 }
  );

  doc.moveDown(0.8);
  section(doc, 'Affordability summary');
  kv(doc, [
    ['Net monthly income (as declared)', fmtZAR(app.netMonthlyIncome)],
    ['Monthly living expenses (as declared)', fmtZAR(app.affordability?.declaredExpenses ?? app.monthlyExpenses)],
    ['Existing debt instalments (total)', fmtZAR(app.existingDebtInstalments)],
    ['Discretionary income after this loan', fmtZAR(app.affordability?.discretionaryIncome)],
  ]);
  if (app.affordability?.expenseFloorApplied) {
    doc.fontSize(8).font('Helvetica').fillColor(INK_SOFT).text(
      `Note: your affordability assessment used a minimum expense figure of ${fmtZAR(app.affordability.deemedMinimumExpense)} for your income band, since this is higher than what you declared — this protects against under-estimating your real cost of living.`,
      { width: 495 }
    );
  }

  if (app.existingDebts && app.existingDebts.length > 0) {
    doc.moveDown(0.4);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK).text('Existing credit obligations declared:', 50);
    app.existingDebts.forEach((d) => {
      doc.fontSize(8.5).font('Helvetica').fillColor(INK_SOFT).text(
        `• ${d.provider} (${d.type}) — balance ${fmtZAR(d.balance)}, instalment ${fmtZAR(d.instalment)}/month`,
        { width: 495 }
      );
    });
  }

  if (app.loanPurpose) {
    doc.moveDown(0.4);
    doc.fontSize(9).font('Helvetica').fillColor(INK_SOFT).text(`Stated purpose of loan: ${app.loanPurpose}`, { width: 495 });
  }

  doc.moveDown(0.8);
  section(doc, 'Your rights');
  bullets(doc, [
    `Reconsideration window: you may cancel this application at no cost within ${reconsiderationDays} business days of signing, before any funds are drawn down beyond what your final agreement specifies. Contact Khula on WhatsApp to exercise this right.`,
    'You have the right to apply to a debt counsellor if you are over-indebted.',
    'You may settle this loan early at any time; early settlement rebates on fees and interest will be calculated per the National Credit Act.',
    'You have the right to request your credit information from Khula and to dispute any information reported to a credit bureau.',
  ]);

  doc.moveDown(0.8);
  section(doc, 'POPIA notice (summary)');
  doc.fontSize(9).font('Helvetica').fillColor(INK_SOFT).text(
    `You consented to Khula processing your personal information for this application on ${app.popiaConsentAt ? new Date(app.popiaConsentAt).toLocaleString('en-ZA') : 'the date of application'}. Your information is used solely to assess and manage this loan unless you separately consent to other uses. You may request access to, correction of, or deletion of your information at any time.`,
    { width: 495 }
  );

  doc.moveDown(0.6);
  section(doc, 'Declarations you made at application');
  bullets(doc, [
    'You consented to Khula processing your personal information under POPIA.',
    'You consented to a credit bureau check being run on your profile.',
    'You confirmed all information provided is true, accurate, and complete, and that nothing material was withheld.',
    'You authorised Khula to verify the information you provided.',
    'You acknowledged that this application does not guarantee approval.',
  ]);

  doc.moveDown(1.2);
  doc.fontSize(8).fillColor(INK_SOFT).text(
    'This is a system-generated pre-agreement statement for demonstration purposes. Before relying on this document with real borrowers, have your compliance officer confirm exact NCA-required wording, fee disclosures, and formatting.',
    { width: 495 }
  );

  doc.end();
}

function section(doc, title) {
  doc.moveDown(0.3);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(FOREST).text(title);
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor('#E7EEE3').lineWidth(1).stroke();
  doc.moveDown(0.4);
}

function kv(doc, pairs) {
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  pairs.forEach(([label, value]) => {
    doc.font('Helvetica').fillColor(INK_SOFT).text(label, 50, doc.y, { continued: true, width: 250 });
    doc.font('Helvetica-Bold').fillColor(INK).text(`  ${value ?? '—'}`);
  });
}

function bullets(doc, items) {
  doc.font('Helvetica').fontSize(9).fillColor(INK_SOFT);
  items.forEach((item) => {
    doc.text(`•  ${item}`, { width: 495, indent: 0 });
    doc.moveDown(0.2);
  });
}

module.exports = { streamPreAgreementPDF };
