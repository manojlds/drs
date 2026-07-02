import * as React from 'react';
import { cn } from '@/renderer/lib/utils';

export function PromptInput({ className, ...props }: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cn('ai-prompt-input', className)} {...props} />;
}

export function PromptInputTextarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('ai-prompt-textarea', className)} {...props} />;
}

export function PromptInputActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ai-prompt-actions', className)} {...props} />;
}
