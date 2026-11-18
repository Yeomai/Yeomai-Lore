import nodemailer from "nodemailer";
import type { AppConfig } from "../config.ts";

export interface Mailer {
  send(
    to: string,
    subject: string,
    body: { text?: string; html?: string },
  ): Promise<void>;
}

class LogMailer implements Mailer {
  async send(
    to: string,
    subject: string,
    body: { text?: string; html?: string },
  ): Promise<void> {
    console.info(
      `[mail disabled] to=${to} subject=${JSON.stringify(subject)}\n${
        body.text ?? body.html ?? ""
      }`,
    );
  }
}

class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(
    to: string,
    subject: string,
    body: { text?: string; html?: string },
  ): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject,
      ...body,
    });
  }
}

export function createMailer(config: AppConfig): Mailer {
  const logMailer = new LogMailer();
  let smtpMailer: SmtpMailer | undefined;
  let currentSmtpConfig = "";
  return {
    async send(to, subject, body) {
      if (!config.smtpUrl) {
        await logMailer.send(to, subject, body);
        return;
      }
      const smtpConfig = `${config.smtpUrl}\n${config.smtpFrom}`;
      if (currentSmtpConfig !== smtpConfig || !smtpMailer) {
        currentSmtpConfig = smtpConfig;
        smtpMailer = new SmtpMailer(config.smtpUrl, config.smtpFrom);
      }
      await smtpMailer.send(to, subject, body);
    },
  };
}
