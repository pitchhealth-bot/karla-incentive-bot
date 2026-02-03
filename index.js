/******************************************************
 * KARLA INCENTIVE BOT — Airtable + Render + Discord
 *
 * ✅ Airtable automation -> POST /send-incentive { recordId }
 * ✅ Bot posts embed with buttons: Approve / Deny
 * ✅ Clicking buttons updates Airtable field "Approval Status"
 *
 * Env Vars (Render):
 *  DISCORD_BOT_TOKEN
 *  DISCORD_CHANNEL_ID
 *  AIRTABLE_TOKEN
 *  AIRTABLE_BASE_ID
 *  AIRTABLE_TABLE_NAME
 *  WEBHOOK_SECRET
 *  PORT (optional)
 ******************************************************/

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

const app = express();
app.use(express.json());

// Log every request (helps debugging)
app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.url);
  next();
});

// ===== ENV =====
const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME,
  WEBHOOK_SECRET,
  PORT
} = process.env;

function reqEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
  return process.env[name];
}

reqEnv("DISCORD_BOT_TOKEN");
reqEnv("DISCORD_CHANNEL_ID");
reqEnv("AIRTABLE_TOKEN");
reqEnv("AIRTABLE_BASE_ID");
reqEnv("AIRTABLE_TABLE_NAME");
reqEnv("WEBHOOK_SECRET");

// ===== Airtable config (YOUR FIELD NAMES) =====
const FIELD_DATE = "Date";
const FIELD_AGENT_NAME = "Agent Name";
const FIELD_INCENTIVE = "Incentive";
const FIELD_SUBMITTED_BY = "Submitted By";
const FIELD_APPROVAL_STATUS = "Approval Status";

// Status values (must match your single select options)
const STATUS_PENDING = "Pending";
const STATUS_APPROVED = "Approved";
const STATUS_DENIED = "Denied";

// ===== Airtable helpers =====
const AIRTABLE_API = "https://api.airtable.com/v0";

async function airtableFetch(path, options = {}) {
  const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    AIRTABLE_TABLE_NAME
  )}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getRecord(recordId) {
  return airtableFetch(`/${recordId}`, { method: "GET" });
}

async function patchRecord(recordId, fields) {
  return airtableFetch("", {
    method: "PATCH",
    body: JSON.stringify({ records: [{ id: recordId, fields }] })
  });
}

// ===== Discord client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ===== Embed + Buttons =====
function safe(val) {
  if (val === undefined || val === null || val === "") return "—";
  return String(val);
}

function buildEmbed(fields) {
  const date = safe(fields[FIELD_DATE]);
  const agentName = safe(fields[FIELD_AGENT_NAME]);
  const incentive = safe(fields[FIELD_INCENTIVE]);
  const submittedBy = safe(fields[FIELD_SUBMITTED_BY]);

  const description = [
    `**${agentName}**`,
    ``,
    `**Date**`,
    `${date}`,
    ``,
    `**Incentive**`,
    `${String(incentive).slice(0, 1200)}`,
    ``,
    `**Submitted By**`,
    `${submittedBy}`
  ].join("\n");

  return new EmbedBuilder()
    .setTitle("🎁 Incentive Approval Request")
    .setDescription(description)
    .setColor(0x7B61FF);
}

function buildButtons(recordId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`inc_approve_${recordId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`inc_deny_${recordId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Secondary)
  );
}

// ===== Routes =====
app.get("/", (req, res) => res.status(200).send("OK"));

// Airtable automation calls this
app.post("/send-incentive", async (req, res) => {
  try {
    const secret = req.headers["x-webhook-secret"];
    if (secret !== WEBHOOK_SECRET) return res.status(401).send("Unauthorized");

    const { recordId } = req.body || {};
    if (!recordId) return res.status(400).send("Missing recordId");

    const record = await getRecord(recordId);
    const fields = record.fields || {};

    // Set Pending (best effort)
    await patchRecord(recordId, { [FIELD_APPROVAL_STATUS]: STATUS_PENDING }).catch(() => {});

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      return res.status(400).send("Channel not found or not text-based");
    }

    const embed = buildEmbed(fields);
    const msg = await channel.send({ embeds: [embed], components: [buildButtons(recordId)] });

    return res.status(200).send(`Sent incentive approval message: ${msg.id}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send(String(err.message || err));
  }
});

// ===== Button handler =====
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const id = interaction.customId || "";
    const isApprove = id.startsWith("inc_approve_");
    const isDeny = id.startsWith("inc_deny_");
    if (!isApprove && !isDeny) return;

    const recordId = id.split("_").slice(2).join("_");
    await interaction.deferReply({ ephemeral: true });

    const record = await getRecord(recordId);
    const fields = record.fields || {};
    const status = fields[FIELD_APPROVAL_STATUS];

    // Stop double-processing
    if (status === STATUS_APPROVED || status === STATUS_DENIED) {
      return interaction.editReply(`This request is already **${status}**.`);
    }

    if (isDeny) {
      await patchRecord(recordId, { [FIELD_APPROVAL_STATUS]: STATUS_DENIED }).catch(() => {});
      await interaction.message.edit({ components: [] }).catch(() => {});
      return interaction.editReply("❌ Denied. Airtable updated and buttons removed.");
    }

    // Approve
    await patchRecord(recordId, { [FIELD_APPROVAL_STATUS]: STATUS_APPROVED }).catch(() => {});
    await interaction.message.edit({ components: [] }).catch(() => {});
    return interaction.editReply("✅ Approved. Airtable updated and buttons removed.");
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Error: ${String(err.message || err)}`).catch(() => {});
    }
  }
});

// ===== Start =====
(async () => {
  const port = Number(PORT || 10000);
  app.listen(port, () => console.log(`🌐 Web server listening on :${port}`));
  await client.login(DISCORD_BOT_TOKEN);
})();
