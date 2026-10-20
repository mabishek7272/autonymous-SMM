import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button, Textarea, useToast } from '../../ui';
import { csvToTsv } from './csv';
import { downloadTemplate, type TemplateKey } from './templates';
import './imports.css';

const MAX_BYTES = 2 * 1024 * 1024;

interface Props {
  label: string;
  value: string;
  onChange: (text: string) => void;
  template: TemplateKey;
  placeholder?: string;
  rows?: number;
}

/**
 * The shared "get rows into an import" control: Upload CSV file, Download template, or paste from a sheet.
 * An uploaded CSV is converted to tab-separated text and shown in the box, so what you see is what is imported.
 */
export function ImportSource({ label, value, onChange, template, placeholder, rows = 9 }: Props) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [fileName, setFileName] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    if (file.size > MAX_BYTES) return void toast.error('That file is larger than 2 MB. Split it into smaller files.');
    if (/\.xlsx?$/i.test(file.name)) return void toast.error('Excel files are not read directly. In Excel use File → Save As → CSV, then upload that.');
    try {
      const text = await file.text();
      onChange(csvToTsv(text));
      setFileName(file.name);
    } catch {
      toast.error('Could not read that file.');
    }
  };

  return (
    <div className="imp">
      <div className="imp__bar">
        <input id={inputId} ref={inputRef} className="imp__file" type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => void onFile(e)} aria-label={`${label}: choose a CSV file`} />
        <Button variant="secondary" size="sm" icon={<Upload size={14} aria-hidden="true" />} onClick={() => inputRef.current?.click()}>
          Upload CSV file
        </Button>
        <Button variant="ghost" size="sm" icon={<Download size={14} aria-hidden="true" />} onClick={() => downloadTemplate(template)}>
          Download template
        </Button>
        <span className="imp__or">{fileName ? `Loaded ${fileName}` : 'or paste rows below'}</span>
      </div>
      <Textarea
        label={label}
        rows={rows}
        value={value}
        onChange={(e) => {
          setFileName(null);
          onChange(e.target.value);
        }}
        placeholder={placeholder}
      />
    </div>
  );
}
