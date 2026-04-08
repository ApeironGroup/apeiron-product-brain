import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not configured. Run: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...");
    }

    const { pdf_base64, product_code } = await req.json();
    if (!pdf_base64 || !product_code) {
      throw new Error("Missing pdf_base64 or product_code");
    }
    // Accept single PDF or array of PDFs — process sequentially to stay within rate limits
    const pdfs: string[] = Array.isArray(pdf_base64) ? pdf_base64 : [pdf_base64];

    // Fetch Apeiron skill extraction rules from GitHub
    const prompt = `You are extracting structured insurance product data from a carrier brochure PDF for Apeiron International.

Product code: ${product_code}

Return ONLY a valid JSON object. No markdown, no preamble.

Extract these fields (use "TBC" if not found):
product_name, company, plan_type, currency (array e.g. ["USD"]), premium_term, policy_term, ecv_scw_option,
jurisdiction, regulatory_regime, governing_law, financial_strength_rating, capital_adequacy_ratio,
ownership, entry_age_min (integer), entry_age_max (integer), entry_age_notes,
eligible_countries, nftf_countries, us_canada_persons, non_med_limit,
death_benefit, terminal_illness, non_lapse_guarantee, death_payout_options, breakeven_year,
num_indices, num_indexed_accounts, net_premium_allocation, index_premium_allocation, index_performance_charges,
segment_initiation_date, partial_withdrawal, free_partial_withdrawal, account_reallocation_frequency,
auto_premium_spread, minimum_premium, backdating, top_up, premium_holiday,
loan_features, policy_loan_interest, change_of_life_assured, contingent_life_insured,
contingent_owner, policy_split, future_insurability, rop_rider, quit_smoking,
incapacity_benefits, conversion_privilege, carrier_privilege,
premium_charge, policy_fee, surrender_charge, free_withdrawal_charge, coi_charges,
index_performance_charge, other_charges,
guaranteed_rate, current_rate, minimum_rate, cumulative_guarantee, loyalty_rate,
index_type, cap_rate, guaranteed_min_cap, floor_rate, participation_rate,
min_participation_rate, multiplier, illustration_rate,
tbc_fields (array of field names not found)`;

    // Extract each PDF sequentially, then merge — non-TBC values win over TBC
    async function extractOnePdf(b64: string): Promise<Record<string, unknown>> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(`Anthropic error: ${JSON.stringify(j.error)}`);
      if (!j.content) throw new Error(`Unexpected response: ${JSON.stringify(j)}`);
      const raw = j.content.map((b: { text?: string }) => b.text || "").join("");
      return JSON.parse(raw.replace(/```json|```/g, "").trim());
    }

    // Process sequentially with a short pause between calls to avoid rate limits
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < pdfs.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 65000)); // 65s gap — stay within 10k TPM/min free tier
      results.push(await extractOnePdf(pdfs[i]));
    }

    // Merge: first result is base, subsequent results fill in TBC/missing fields
    const merged: Record<string, unknown> = { ...results[0] };
    for (let i = 1; i < results.length; i++) {
      for (const [key, val] of Object.entries(results[i])) {
        if (key === "tbc_fields") continue;
        const existing = merged[key];
        const isTbc = !existing || existing === "TBC" || (Array.isArray(existing) && existing.length === 0);
        if (isTbc && val && val !== "TBC") merged[key] = val;
      }
    }
    // Rebuild tbc_fields from merged result
    const allFields = Object.keys(results[0]).filter(k => k !== "tbc_fields");
    merged["tbc_fields"] = allFields.filter(k => !merged[k] || merged[k] === "TBC");

    return new Response(JSON.stringify(merged), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
