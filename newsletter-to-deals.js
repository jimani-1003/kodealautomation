import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  `https://${process.env.SUPABASE_PROJECT_ID}.supabase.co`,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  "urn:ietf:wg:oauth:2.0:oob"
);
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oauth2Client });

const KEYWORDS = ["sale","% off","discount","deal","coupon","promo","flash","clearance","savings","free shipping","limited time","last chance","today only","holiday","할인","특가","세일"];
const TAG = process.env.AMAZON_AFFILIATE_TAG || "kodeal-20";
const DAYS = parseInt(process.argv.find(a=>a.startsWith("--days="))?.split("=")[1] || "1");
const DRY = process.argv.includes("--dry-run");

async function searchEmails() {
  const q = KEYWORDS.map(k=>`subject:"${k}"`).join(" OR ");
  const after = Math.floor((Date.now() - DAYS*86400000)/1000);
  const res = await gmail.users.messages.list({ userId:"me", q:`(${q}) after:${after}`, maxResults:20 });
  return res.data.messages || [];
}

async function getBody(id) {
  const res = await gmail.users.messages.get({ userId:"me", id, format:"full" });
  const msg = res.data;
  const subject = msg.payload.headers.find(h=>h.name==="Subject")?.value || "";
  const from = msg.payload.headers.find(h=>h.name==="From")?.value || "";
  let body = "";
  const parts = msg.payload.parts || [msg.payload];
  for (const p of parts) {
    if (p.mimeType === "text/plain" && p.body?.data) { body = Buffer.from(p.body.data,"base64").toString(); break; }
  }
  if (!body) for (const p of parts) {
    if (p.mimeType === "text/html" && p.body?.data) { body = Buffer.from(p.body.data,"base64").toString().replace(/<[^>]+>/g,"").slice(0,3000); break; }
  }
  return { subject, from, body: body.slice(0,3000) };
}

async function extractDeals({ subject, from, body }) {
  const res = await anthropic.messages.create({
    model:"claude-sonnet-4-6", max_tokens:2000,
    messages:[{ role:"user", content:"KoDeal 딜 추출. 발신:"+from+" 제목:"+subject+" 본문:"+body+" JSON배열만출력:[{title,category,original_price,sale_price,discount_rate,deal_url,image_url,description,brand,expiry_date}] 딜없으면[]" }]
  });
  try { return JSON.parse(res.content[0].text.replace(/```json|```/g,"").trim()); } catch { return []; }
}

function affiliateUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname.includes("amazon.com")) {
      const asin = u.pathname.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
      return asin ? "https://www.amazon.com/dp/"+asin+"?tag="+TAG : (u.searchParams.set("tag",TAG), u.toString());
    }
  } catch {}
  return url;
}

async function main() {
  console.log("KoDeal 자동화 시작 (" + (DRY?"DRY RUN":"실제저장") + ", " + DAYS + "일)");
  let msgs;
  try {
    msgs = await searchEmails();
  } catch (err) {
    if (err.message?.includes("invalid_grant") || err.response?.data?.error === "invalid_grant") {
      console.error("[인증 오류] Gmail refresh_token이 만료되었습니다.");
      console.error("해결: node reauth.cjs 실행 후 다시 시도하세요.");
      process.exit(1);
    }
    throw err;
  }
  console.log(msgs.length + "개 이메일 발견");
  let saved=0, skipped=0;
  for (const m of msgs) {
    const email = await getBody(m.id);
    console.log("처리중: " + email.subject);
    const deals = await extractDeals(email);
    console.log("  -> " + deals.length + "개 딜");
    for (const d of deals) {
      if (!DRY) {
        const { data } = await supabase.from("deals").select("id").eq("deal_url",d.deal_url).limit(1);
        if (data?.length) { skipped++; continue; }
        const { error } = await supabase.from("deals").insert({...d, deal_url:affiliateUrl(d.deal_url), status:"draft", source:"newsletter", source_email:email.from, created_at:new Date().toISOString()});
        if (error) console.error("오류: "+error.message); else { console.log("저장: "+d.title); saved++; }
      } else { console.log("[DRY] "+d.title+" | "+d.category+" | $"+d.sale_price); }
    }
  }
  console.log("완료! 저장:"+saved+" 스킵:"+skipped);
}
main();