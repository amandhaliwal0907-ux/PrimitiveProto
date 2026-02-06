import streamlit as st
from config import supabase

st.title("Primitives Viewer")

# Fetch primitives from Supabase
def fetch_primitives():
    if not supabase:
        return []
    try:
        res = supabase.table("primitives2").select("id, primitive").execute()
        return res.data if res.data else []
    except Exception as e:
        st.error(f"Error fetching primitives: {e}")
        return []

# Delete primitive by id
def delete_primitive(primitive_id):
    if not supabase:
        return
    try:
        supabase.table("primitives2").delete().eq("id", primitive_id).execute()
        st.success("Primitive deleted.")
    except Exception as e:
        st.error(f"Error deleting primitive: {e}")

primitives = fetch_primitives()

if not primitives:
    st.info("No primitives found.")
else:
    for primitive in primitives:
        col1, col2 = st.columns([8, 1])
        with col1:
            st.write(primitive["primitive"])
        with col2:
            if st.button("Delete", key=primitive["id"]):
                delete_primitive(primitive["id"])
                st.experimental_rerun()
