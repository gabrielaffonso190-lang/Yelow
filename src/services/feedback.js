import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { BRAND, withBrandSignature } from '../config/brand.js';
import { withTransaction, writeAuditLog } from './db.js';

export const DEFAULT_FEEDBACK_CHANNEL_ID = '1560463437463822377';
const deletionTimers = new Map();

export function buildFeedbackRequest(request, env = process.env) {
  const embed = withBrandSignature(new EmbedBuilder()
    .setColor(BRAND.colors.white)
    .setTitle('VANTA | Como foi seu atendimento?')
    .setDescription([
      'Agradecemos pela sua compra. Sua avaliação nos ajuda a manter a qualidade do atendimento.',
      `Pedido: \`${request.order_id}\``,
      `Carrinho: \`${request.channel_id}\``,
      `Data e horário: <t:${Math.floor(Date.parse(request.created_at) / 1000)}:F>`,
    ].join('\n')));
  const imageUrl = env.VANTA_FEEDBACK_IMAGE_URL?.trim();
  if (imageUrl && /^https:\/\//i.test(imageUrl)) {
    embed.setImage(imageUrl);
  }

  const buttons = new ActionRowBuilder().addComponents(
    ...[1, 2, 3, 4, 5].map((rating) => new ButtonBuilder()
      .setCustomId(`feedback:rate:${request.id}:${rating}`)
      .setLabel(`${rating} estrela${rating === 1 ? '' : 's'}`)
      .setStyle(rating === 5 ? ButtonStyle.Primary : ButtonStyle.Secondary)),
  );
  return { embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
}

export async function sendOrderFeedbackRequest({ db, client, orderId, env = process.env }) {
  const request = db.prepare(`
    SELECT * FROM order_feedback_requests WHERE order_id = ?
  `).get(orderId);
  if (!request || request.status !== 'pending') return false;

  let dmError;
  try {
    const user = await client.users.fetch(request.user_id);
    await user.send(buildFeedbackRequest(request, env));
    db.prepare(`
      UPDATE order_feedback_requests SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), request.id);
    writeAuditLog(db, request.guild_id, client.user.id, 'feedback.dm_sent', {
      orderId,
      requestId: request.id,
    });
    return true;
  } catch (error) {
    dmError = error;
  }

  const failureCode = String(dmError?.code || dmError?.name || 'DM_UNAVAILABLE').slice(0, 80);
  db.prepare(`
    UPDATE order_feedback_requests SET status = 'dm_failed', failure_code = ?
    WHERE id = ? AND status = 'pending'
  `).run(failureCode, request.id);
  writeAuditLog(db, request.guild_id, client.user.id, 'feedback.dm_failed', {
    orderId,
    requestId: request.id,
    failureCode,
  });

  const channelId = env.VANTA_FEEDBACK_CHANNEL_ID?.trim() || DEFAULT_FEEDBACK_CHANNEL_ID;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.isSendable()) return false;
    await channel.send({
      content: `Não foi possível enviar a avaliação por DM para <@${request.user_id}>.`,
      ...buildFeedbackRequest(request, env),
      allowedMentions: { users: [request.user_id] },
    });
    return true;
  } catch {
    return false;
  }
}

export async function recoverPendingFeedbackRequests({ db, client, env = process.env }) {
  const pending = db.prepare(`
    SELECT order_id FROM order_feedback_requests WHERE status = 'pending'
    ORDER BY created_at
  `).all();
  for (const request of pending) {
    await sendOrderFeedbackRequest({ db, client, orderId: request.order_id, env });
  }
  return pending.length;
}

export function recordOrderFeedback(db, requestId, userId, rating, comment = '') {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5
    || typeof comment !== 'string' || comment.length > 500) {
    return { ok: false, reason: 'invalid' };
  }

  return withTransaction(db, () => {
    const request = db.prepare(`
      SELECT * FROM order_feedback_requests WHERE id = ?
    `).get(requestId);
    if (!request || request.user_id !== userId) return { ok: false, reason: 'not_found' };

    const existing = db.prepare(
      'SELECT order_id FROM order_feedback WHERE order_id = ?',
    ).get(request.order_id);
    if (existing) return { ok: false, reason: 'duplicate' };

    const submittedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO order_feedback
        (order_id, request_id, guild_id, user_id, rating, comment, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.order_id,
      request.id,
      request.guild_id,
      request.user_id,
      rating,
      comment.trim(),
      submittedAt,
    );
    db.prepare(`
      UPDATE order_feedback_requests SET status = 'submitted' WHERE id = ?
    `).run(request.id);
    writeAuditLog(db, request.guild_id, userId, 'feedback.submitted', {
      orderId: request.order_id,
      requestId: request.id,
      rating,
      submittedAt,
    });
    return { ok: true, orderId: request.order_id };
  });
}

export async function handleFeedbackInteraction(interaction, { db }) {
  if (!interaction.isButton() || !interaction.customId.startsWith('feedback:rate:')) {
    return false;
  }

  const [, , requestId, rawRating] = interaction.customId.split(':');
  const rating = Number(rawRating);
  const request = db.prepare(
    'SELECT * FROM order_feedback_requests WHERE id = ?',
  ).get(requestId);
  if (!request || request.user_id !== interaction.user.id) {
    await interaction.reply({ content: 'Esta avaliação não pertence a você.', ephemeral: true });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`feedback:submit:${requestId}:${rating}`)
    .setTitle('Avaliar atendimento');
  const comment = new TextInputBuilder()
    .setCustomId('comment')
    .setLabel('Comentário (opcional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);
  modal.addComponents(new ActionRowBuilder().addComponents(comment));
  await interaction.showModal(modal);
  return true;
}

export async function handleFeedbackModal(interaction, { db }) {
  if (!interaction.customId.startsWith('feedback:submit:')) return false;
  const [, , requestId, rawRating] = interaction.customId.split(':');
  const comment = interaction.fields.getTextInputValue('comment');
  const result = recordOrderFeedback(db, requestId, interaction.user.id, Number(rawRating), comment);
  const responses = {
    invalid: 'A avaliação enviada não é válida.',
    not_found: 'Esta avaliação não pertence a você.',
    duplicate: 'Este pedido já possui uma avaliação registrada. Obrigado!',
  };
  await interaction.reply({
    content: result.ok ? 'Obrigado por avaliar o atendimento da VANTA.' : responses[result.reason],
    ephemeral: true,
  });
  return true;
}

export function scheduleClosedTicketDeletion({
  db,
  client,
  ticket,
  now = Date.now(),
  setTimeoutImpl = setTimeout,
}) {
  if (!ticket?.channel_id || !ticket.close_after_at || deletionTimers.has(ticket.channel_id)) return null;
  const delay = Math.max(0, Date.parse(ticket.close_after_at) - now);
  const timer = setTimeoutImpl(async () => {
    deletionTimers.delete(ticket.channel_id);
    const current = db.prepare(`
      SELECT status, channel_id FROM tickets WHERE order_id = ?
    `).get(ticket.order_id);
    if (current?.status !== 'closed' || current.channel_id !== ticket.channel_id) return;
    try {
      const channel = await client.channels.fetch(ticket.channel_id);
      if (channel) await channel.delete('Carrinho encerrado; prazo de feedback iniciado.');
      writeAuditLog(db, ticket.guild_id, client.user.id, 'ticket.channel_deleted', {
        orderId: ticket.order_id,
        channelId: ticket.channel_id,
      });
    } catch (error) {
      writeAuditLog(db, ticket.guild_id, client.user.id, 'ticket.channel_delete_failed', {
        orderId: ticket.order_id,
        channelId: ticket.channel_id,
        error: String(error?.code || error?.name || 'UNKNOWN').slice(0, 80),
      });
    }
  }, delay);
  timer.unref?.();
  deletionTimers.set(ticket.channel_id, timer);
  return delay;
}

export function recoverClosedTicketDeletions({ db, client }) {
  const closedTickets = db.prepare(`
    SELECT order_id, guild_id, channel_id, close_after_at FROM tickets
    WHERE status = 'closed' AND channel_id IS NOT NULL AND close_after_at IS NOT NULL
  `).all();
  for (const ticket of closedTickets) {
    scheduleClosedTicketDeletion({ db, client, ticket });
  }
  return closedTickets.length;
}

export function createFeedbackRequestId() {
  return randomUUID();
}