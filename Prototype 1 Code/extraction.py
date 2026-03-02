import re
import json
from docx import Document
import PyPDF2

def read_docx(path):
    doc = Document(path)
    full_text = []
    for para in doc.paragraphs:
        full_text.append(para.text)
    return "\n".join(full_text)

def read_pdf(path):
    text = []
    with open(path, 'rb') as file:
        reader = PyPDF2.PdfReader(file)
        for page in reader.pages:
            text.append(page.extract_text())
    return "\n".join(text)


def extract_checklist_items(text, verbose=False):
    """Heuristically extract checklist-like lines from the text. Returns list of candidates."""
    def preprocess_text(t):
        t = re.sub(r"Page\s*\d+", "", t, flags=re.I)
        t = re.sub(r"page\s*\d+", "", t, flags=re.I)
        t = re.sub(r"Figure\s*\d+[:\.]?", "", t, flags=re.I)
        t = re.sub(r"Fig\.\s*\d+[:\.]?", "", t, flags=re.I)
        t = re.sub(r"\s+", " ", t)
        return t.strip()

    cleaned = preprocess_text(text)
    # Paragraphs: split on double newlines, fallback to single newlines
    paragraphs = [p.strip() for p in re.split(r"\n{2,}|\r{2,}", cleaned) if p.strip()]
    if len(paragraphs) <= 1:
        paragraphs = [p.strip() for p in re.split(r"\n|\r", cleaned) if p.strip()]

    # Sentences: split on punctuation
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", cleaned) if len(s.strip().split()) > 3]

    # Combine Q&A pairs in paragraphs (reuse previous logic if needed)
    # For now, just add all paragraphs and all sentences
    candidates = paragraphs + sentences

    # Filter out obvious non-actionable lines (headers, page numbers, metadata, very short lines)
    reject_patterns = [
        r'table of contents', r'amendment record', r'version', r'online:', r'email:', r'this document is for',
        r'not legal advice', r'copyright', r'all rights reserved', r'contact', r'introduction', r'overview',
        r'page \d+', r'section \d+', r'figure', r'amendment', r'template', r'description', r'^q:', r'^a:'
    ]
    filtered = []
    for c in candidates:
        c_strip = c.strip()
        if len(c_strip.split()) < 4:
            continue
        skip = False
        for rp in reject_patterns:
            if re.search(rp, c_strip, flags=re.I):
                skip = True
                break
        if skip:
            continue
        filtered.append(c_strip)

    # Deduplicate
    seen = set()
    dedup = []
    for c in filtered:
        if c not in seen:
            seen.add(c)
            dedup.append(c)

    if verbose:
        print(f"Extraction: {len(dedup)} candidates (sentences + paragraphs)")
    return dedup
