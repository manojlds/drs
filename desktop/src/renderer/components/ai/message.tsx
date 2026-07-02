import * as React from 'react';
import { cn } from '@/renderer/lib/utils';

export interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  from: 'user' | 'assistant' | 'system';
}

export function Message({ from, className, ...props }: MessageProps) {
  return <div className={cn('ai-message', `ai-message-${from}`, className)} {...props} />;
}

export function MessageContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ai-message-content', className)} {...props} />;
}

export function MessageAvatar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ai-message-avatar', className)} {...props} />;
}
