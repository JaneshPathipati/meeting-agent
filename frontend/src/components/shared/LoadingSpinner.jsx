// file: frontend/src/components/shared/LoadingSpinner.jsx
import React from 'react';
import { Loader2 } from 'lucide-react';

const sizes = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-10 w-10',
};

function LoadingSpinner({ size = 'md', className = '' }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <Loader2 className={`${sizes[size]} animate-spin text-brand-600`} />
    </div>
  );
}

export default LoadingSpinner;
