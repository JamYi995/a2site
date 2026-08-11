import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailSender, OtpEmail } from '@a2site/identity';

export interface SmtpEmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
  replyTo?: string;
}

interface MailTransport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

export class SmtpEmailSender implements EmailSender {
  readonly deliveryKind = 'smtp';
  private readonly transport: MailTransport;

  constructor(
    private readonly config: SmtpEmailConfig,
    transport?: MailTransport,
  ) {
    this.transport = transport ?? this.createTransport();
  }

  async sendOtp(input: OtpEmail): Promise<void> {
    await this.transport.sendMail({
      from: { name: this.config.fromName, address: this.config.fromAddress },
      to: input.recipient,
      ...(this.config.replyTo ? { replyTo: this.config.replyTo } : {}),
      subject: 'A2Site Agent 连接验证码',
      text: [
        `你的 A2Site Agent 连接验证码是：${input.code}`,
        '',
        `验证码有效期至：${input.expiresAt.toISOString()}`,
        `站点：${input.siteId}`,
        '',
        '如果不是你发起的操作，请忽略这封邮件。不要把验证码提供给不受信任的人或 Agent。',
      ].join('\n'),
    });
  }

  private createTransport(): Transporter {
    return nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      requireTLS: !this.config.secure,
      auth: {
        user: this.config.user,
        pass: this.config.password,
      },
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
}
