from config import supabase
import json

def store_primitive(primitive):
    if not supabase:
        print("SUPABASE client not configured — skipping storage.")
        return
    payload = {
        "primitive": primitive
    }
    try:
        supabase.table("primitives2").insert(payload).execute()
        print("Stored primitive in Supabase (primitives2)")
    except Exception as e:
        print(f"Error storing primitive to Supabase: {e}")
