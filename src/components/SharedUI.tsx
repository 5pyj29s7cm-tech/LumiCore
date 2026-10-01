import React from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from './ui/card';
import { cn } from '@/lib/utils';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  hoverEffect?: boolean;
}

export function GlassCard({ children, className, hoverEffect = true, ...props }: GlassCardProps) {
  return (
    <Card 
      className={cn(
        "glass-panel p-8 transition-all duration-500 relative overflow-hidden group",
        hoverEffect && "hover:border-celestial-saturn/30 hover:shadow-[0_0_40px_rgba(255,204,0,0.05)]",
        className
      )}
      {...props}
    >
      {hoverEffect && (
        <div className="absolute inset-0 bg-gradient-to-br from-celestial-saturn/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
      )}
      <div className="relative z-10">
        {children}
      </div>
    </Card>
  );
}

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center min-h-[400px]", className)}>
      <Loader2 className="animate-spin text-celestial-saturn" size={48} />
    </div>
  );
}

interface IconBoxProps {
  icon: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function IconBox({ icon, className, size = 'md' }: IconBoxProps) {
  const sizes = {
    sm: 'w-10 h-10 rounded-xl',
    md: 'w-14 h-14 rounded-2xl',
    lg: 'w-20 h-20 rounded-3xl'
  };

  return (
    <div className={cn(
      "bg-white/5 flex items-center justify-center transition-transform group-hover:scale-110",
      sizes[size],
      className
    )}>
      {icon}
    </div>
  );
}
