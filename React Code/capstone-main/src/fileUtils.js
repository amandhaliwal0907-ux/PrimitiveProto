// fileUtils.js
// Browser-only version using global pdfjsLib and mammoth

const pdfjsLib = window.pdfjsLib;
const mammoth = window.mammoth;

// Extract text from PDF
export const extractTextFromPDF = async (file) => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + "\n";
  }

  return text;
};

// Extract text from Word (.docx)
export const extractTextFromWord = async (file) => {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
};

// Auto-detect file type
export const extractFileText = async (file) => {
  if (file.name.endsWith(".pdf")) return extractTextFromPDF(file);
  if (file.name.endsWith(".docx")) return extractTextFromWord(file);
  return await file.text(); // plain text fallback
};
