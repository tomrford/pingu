import { config } from "./config";
import {
  type PendingQuestion,
  type QuestionInfo,
  type AnswerResult,
  TimeoutError,
  ShutdownError,
} from "./types";

export class QuestionStore {
  private questions = new Map<string, PendingQuestion>();
  private onQuestionAdded?: (question: QuestionInfo) => void;
  private onQuestionRemoved?: (id: string) => void;

  setCallbacks(callbacks: {
    onQuestionAdded?: (question: QuestionInfo) => void;
    onQuestionRemoved?: (id: string) => void;
  }) {
    this.onQuestionAdded = callbacks.onQuestionAdded;
    this.onQuestionRemoved = callbacks.onQuestionRemoved;
  }

  create(data: { text: string; cwd: string }): { id: string; promise: Promise<string> } {
    const id = crypto.randomUUID();
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;

    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const createdAt = Date.now();

    const timer = setTimeout(() => {
      this.questions.delete(id);
      this.onQuestionRemoved?.(id);
      reject(new TimeoutError());
    }, config.timeoutMs);

    const question: PendingQuestion = {
      id,
      text: data.text,
      cwd: data.cwd,
      createdAt,
      resolve,
      reject,
      timer,
    };

    this.questions.set(id, question);
    this.onQuestionAdded?.({ id, text: data.text, cwd: data.cwd, createdAt });

    // Notify via ntfy (fire and forget)
    const dirName = data.cwd.split("/").pop() || data.cwd;
    const ntfyUrl = config.ntfyUrl;
    if (ntfyUrl) {
      fetch(ntfyUrl, {
        method: "POST",
        body: `[${dirName}] ${data.text}`,
      })
        .then((res) => {
          if (!res.ok) {
            console.error(`[ntfy] failed: ${res.status} ${res.statusText}`);
          }
        })
        .catch((err) => {
          console.error(`[ntfy] error:`, err.message);
        });
    } else {
      console.warn("[ntfy] NTFY_URL not set, skipping notification");
    }

    return { id, promise };
  }

  answer(id: string, answerText: string): AnswerResult {
    const question = this.questions.get(id);
    if (!question) {
      return "not_found";
    }

    clearTimeout(question.timer);
    this.questions.delete(id);
    this.onQuestionRemoved?.(id);
    question.resolve(answerText);

    return "answered";
  }

  list(): QuestionInfo[] {
    return Array.from(this.questions.values()).map(({ id, text, cwd, createdAt }) => ({
      id,
      text,
      cwd,
      createdAt,
    }));
  }

  shutdown(): void {
    for (const question of this.questions.values()) {
      clearTimeout(question.timer);
      question.reject(new ShutdownError());
    }
    this.questions.clear();
  }
}

export const store = new QuestionStore();
