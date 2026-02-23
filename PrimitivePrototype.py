import os
import json
import re
from extraction import read_pdf, read_docx, extract_checklist_items
from generator import generate_primitives_from_block
from storage import store_primitive


def main():
    script_dir = os.path.dirname(__file__)
    print("Available PDF/DOCX files in current directory:")
    files = [f for f in os.listdir(script_dir) if f.endswith((".pdf", ".docx"))]
    for idx, file in enumerate(files, 1):
        print(f"  {idx}. {file}")

    if not files:
        print("No PDF or DOCX files found in the script directory.")
        return
    elif len(files) == 1:
        file_path = os.path.join(script_dir, files[0])
        print(f"Auto-selected file: {files[0]}")
    else:
        choice = input("\nEnter file number or full path: ").strip()
        try:
            file_idx = int(choice) - 1
            if 0 <= file_idx < len(files):
                file_path = os.path.join(script_dir, files[file_idx])
            else:
                file_path = choice
        except ValueError:
            file_path = choice

    if not os.path.exists(file_path):
        print(f"File not found: {file_path}")
        print(f"Current directory: {script_dir}")
        return

    print(f"2Found file: {os.path.basename(file_path)}")


    # Read document and split into pages
    if file_path.endswith('.pdf'):
        import pdfplumber
        pages = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    pages.append(text)
    elif file_path.endswith('.docx'):
        doc = __import__('docx').Document(file_path)
        # Group paragraphs by page breaks if present, else treat all as one page
        pages = []
        current = []
        for para in doc.paragraphs:
            if para.text.strip() == '':
                continue
            current.append(para.text)
        if current:
            pages.append('\n'.join(current))
    else:
        print("Unsupported file type. Use .pdf or .docx")
        return

    print(f"Extracted {len(pages)} pages from document")

    generated_count = 0
    stored_count = 0
    skipped_count = 0
    error_count = 0

    for i, page_text in enumerate(pages, 1):
        if not page_text or not page_text.strip():
            skipped_count += 1
            continue

        print(f"\n{'='*60}")
        print(f"Scanning page {i}...")
        print('='*60)

        try:
            print("Generating primitives from page...")
            primitives = generate_primitives_from_block(page_text)
            if not primitives:
                print("No valid primitives generated from this page. Skipping.")
                skipped_count += 1
                continue
            for primitive in primitives:
                generated_count += 1
                print("\nPrimitive generated:")
                print(primitive)
                try:
                    store_primitive(primitive)
                    stored_count += 1
                except Exception as e:
                    print(f"Error storing primitive (continuing): {e}")
                    error_count += 1
        except Exception as e:
            print(f"Unexpected error processing page {i}: {e}")
            error_count += 1
            continue

    print('\nProcessing complete.')
    print(f'Generated: {generated_count}, Stored: {stored_count}, Skipped (empty): {skipped_count}, Errors: {error_count}')
    print("\nPrimitive generation complete!")


if __name__ == "__main__":
    main()
