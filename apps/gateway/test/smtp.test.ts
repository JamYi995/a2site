import { describe, expect, it, vi } from 'vitest';
import { SmtpEmailSender } from '../src/smtp.js';

describe('SmtpEmailSender', () => {
  it('通过正式邮件适配器发送验证码且不修改收件人', async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ['user@example.com'] });
    const sender = new SmtpEmailSender({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'smtp-user',
      password: 'smtp-password',
      fromAddress: 'agent@example.com',
      fromName: 'A2Site',
      replyTo: 'support@example.com',
    }, { sendMail });

    await sender.sendOtp({
      challengeId: 'challenge-id',
      recipient: 'user@example.com',
      code: '123456',
      expiresAt: new Date('2026-08-11T12:00:00.000Z'),
      siteId: 'jamboxsys',
    });

    expect(sender.deliveryKind).toBe('smtp');
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      subject: 'A2Site Agent 连接验证码',
      text: expect.stringContaining('123456'),
    }));
  });
});
