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
  section(doc, 'Loan terms offered');
  kv(doc, [
    ['Principal amount', fmtZAR(app.requestedAmount)],
    ['Term', `${app.termMonths} months`],
    ['Estimated monthly instalment', fmtZAR(app.affordability?.proposedInstalment)],
    ['Estimated total repayable', fmtZAR((app.affordability?.proposedInstalment || 0) * app.termMonths)],
  ]);
  doc.fontSize(8).fillColor(INK_SOFT).text(
    'Figures are estimates based on the information you provided and Khula\'s standard pricing at the time of application. Your final agreement will confirm the exact interest rate, initiation fee, monthly service fee, and total cost of credit as required by the National Credit Act.',
    { width: 495 }
  );

  doc.moveDown(0.8);
  section(doc, 'Affordability summary');
  kv(doc, [
    ['Net monthly income (as declared)', fmtZAR(app.netMonthlyIncome)],
    ['Monthly expenses (as declared)', fmtZAR(app.monthlyExpenses)],
    ['Existing debt instalments (as declared)', fmtZAR(app.existingDebtInstalments)],
    ['Discretionary income after this loan', fmtZAR(app.affordability?.discretionaryIncome)],
  ]);

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
