'use client';

import { useId, useState } from 'react';
import { ChevronDownIcon, EyeIcon, EyeOffIcon } from './icons';

const CONTROL_CLASSES =
  'w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-11 pr-11 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:bg-slate-50';

/**
 * Reusable auth form control.
 * as="input"  -> text/password input
 * as="select" -> strict dropdown
 * as="combo"  -> free-text input with suggestions (datalist), so departments
 *                such as "Desma" can be typed even when not pre-listed.
 */
export default function AuthInput({
  label,
  as = 'input',
  type = 'text',
  value,
  onChange,
  placeholder,
  icon,
  options = [],
  autoComplete,
  required = true,
  disabled = false,
}) {
  const [showPassword, setShowPassword] = useState(false);
  const reactId = useId();
  const isPassword = type === 'password';
  const effectiveType = isPassword && showPassword ? 'text' : type;

  return (
    <div>
      <label htmlFor={reactId} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="relative">
        {icon ? (
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
            {icon}
          </span>
        ) : null}

        {as === 'select' ? (
          <>
            <select
              id={reactId}
              value={value}
              onChange={onChange}
              disabled={disabled}
              required={required}
              className={`${CONTROL_CLASSES} appearance-none ${value ? '' : 'text-slate-400'}`}
            >
              <option value="" disabled>
                {placeholder || 'Select an option'}
              </option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </>
        ) : (
          <>
            <input
              id={reactId}
              type={effectiveType}
              value={value}
              onChange={onChange}
              placeholder={placeholder}
              autoComplete={autoComplete}
              required={required}
              disabled={disabled}
              list={as === 'combo' ? `${reactId}-options` : undefined}
              className={CONTROL_CLASSES}
            />
            {as === 'combo' ? (
              <datalist id={`${reactId}-options`}>
                {options.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            ) : null}
          </>
        )}

        {isPassword ? (
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 transition hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {showPassword ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}
