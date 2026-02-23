import config
client = config.openai

# Baseline system prompt for primitive extraction
PRIMITIVE_SYSTEM_PROMPT = """
You are an expert at software and AI agent development, with additional
expertise in the development of primitives for defining rule sets. The rule sets are
required to enforce the actions of a platform or Agent, and are used to eliminate
AI hallucinations. The rule sets can be inherent in simple tools like checklists,
process flowcharts, standard operating procedures, and/or legislation. You must
be able to recognize what the rule sets are in different sources.
Extract every enforceable operational rule, requirement, or prohibition
("primitive") from the provided text block or attached file. A primitive is the
smallest enforceable operational truth. It can be a procedural rule, a legal rule, or
any actionable instruction, even if embedded in a paragraph, bullet, or Q&A
format.
Output must be a JSON array of strings, where each string is a single enforceable
rule or statement. Do not include any explanations, reasoning, or text outside the
JSON array.
If the page contains multiple rules, extract each as a separate string in the array.
If no primitives are present, return an empty array [].
Legal context (BC Emergency and Disaster Management Act 2023). These are valid
primitives when relevant to the input text:
- s.52: Local government must have an emergency plan that includes evacuation
support.
- s.95: Local government may declare a state of local emergency.
- s.77: Provincial Minister may order an evacuation if the local government is
unable or unwilling.
- s.107: Authorities may issue evacuation alerts/orders and modify or rescind
them as required for response and public safety; this enables extraordinary
powers under Part 5, Division 4, ss.75-78.
Extraordinary powers (use only if the input text is about these powers):
- Essential goods and services control
- Price regulation to prevent gouging
- Rationing and distribution of scarce supplies
- Requisition of qualified services
- Use of property and equipment
- Entry without warrant for rescue/hazard/utility security
- Removal or demolition of unsafe structures
- Evacuations and removals of people and animals
- Control of travel and access
- Restriction of businesses and events
- Control of dangerous activities
Do NOT generate a primitive for:
-- section headers, introductions, metadata, or references
-- "see page"/"refer to" statements
If no valid primitive exists, output an empty list [].
"""
def generate_primitives_from_block(text_block, context_text=None):
    messages = [
        {"role": "system", "content": PRIMITIVE_SYSTEM_PROMPT},
        {"role": "user", "content": text_block}
    ]
    if context_text:
        messages.append({"role": "user", "content": f"Context: {context_text}"})
    response = client.chat.completions.create(
        model="gpt-5.2-2025-12-11",
        messages=messages,
        temperature=0.2,
        max_tokens=2048
    )
    import json
    try:
        content = response.choices[0].message.content
        # Remove Markdown code block markers if present
        lines = content.strip().splitlines()
        if lines and lines[0].strip().startswith('```'):
            # Remove all lines that are just code block markers
            lines = [line for line in lines if not line.strip().startswith('```')]
            content = '\n'.join(lines).strip()
        return json.loads(content)
    except Exception as e:
        return []
