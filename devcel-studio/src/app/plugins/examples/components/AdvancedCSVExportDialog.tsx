import { csvT } from '../csvLocalization';
import { t, useI18n } from '@/app/i18n';
import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

interface AdvancedCSVExportDialogProps {
    onClose?: () => void;
    onConfirm?: (options: any) => void;
}

export const AdvancedCSVExportDialog: React.FC<AdvancedCSVExportDialogProps> = ({ onClose, onConfirm }) => {
    useI18n();
    const [options, setOptions] = useState({
        delimiter: ',',
        quoteChar: '"',
        escapeChar: '\\',
        includeHeaders: true,
        includeRowNumbers: false,
        dateFormat: 'ISO',
        numberFormat: 'auto',
        encoding: 'utf-8'
    });

    const handleConfirm = () => {
        onConfirm?.(options);
    };

    return (
        <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                    <Label htmlFor="delimiter">{csvT('delimiter')}</Label>
                    <Select
                        value={options.delimiter}
                        onValueChange={(value) => setOptions({ ...options, delimiter: value })}
                    >
                        <SelectTrigger id="delimiter">
                            <SelectValue placeholder={csvT('selectDelimiter')} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value=",">{csvT('comma')}</SelectItem>
                            <SelectItem value=";">{csvT('semicolon')}</SelectItem>
                            <SelectItem value="	">{csvT('tab')}</SelectItem>
                            <SelectItem value="|">{csvT('pipe')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="encoding">{csvT('encoding')}</Label>
                    <Select
                        value={options.encoding}
                        onValueChange={(value) => setOptions({ ...options, encoding: value })}
                    >
                        <SelectTrigger id="encoding">
                            <SelectValue placeholder={csvT('selectEncoding')} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="utf-8">UTF-8</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                    <Label htmlFor="quoteChar">{csvT('quote')}</Label>
                    <Input
                        id="quoteChar"
                        value={options.quoteChar}
                        onChange={(e) => setOptions({ ...options, quoteChar: e.target.value })}
                        maxLength={1}
                    />
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="escapeChar">{csvT('escape')}</Label>
                    <Input
                        id="escapeChar"
                        value={options.escapeChar}
                        onChange={(e) => setOptions({ ...options, escapeChar: e.target.value })}
                        maxLength={1}
                    />
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                    <Label htmlFor="dateFormat">{csvT('dateFormat')}</Label>
                    <Select
                        value={options.dateFormat}
                        onValueChange={(value) => setOptions({ ...options, dateFormat: value })}
                    >
                        <SelectTrigger id="dateFormat">
                            <SelectValue placeholder={csvT('dateFormat')} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ISO">{csvT('isoDate')}</SelectItem>
                            <SelectItem value="US">{csvT('usDate')}</SelectItem>
                            <SelectItem value="EU">{csvT('euDate')}</SelectItem>
                            <SelectItem value="JP">{csvT('jpDate')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="numberFormat">{csvT('numberFormat')}</Label>
                    <Select
                        value={options.numberFormat}
                        onValueChange={(value) => setOptions({ ...options, numberFormat: value })}
                    >
                        <SelectTrigger id="numberFormat">
                            <SelectValue placeholder={csvT('numberFormat')} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="auto">{csvT('autoNumber')}</SelectItem>
                            <SelectItem value="decimal-dot">{csvT('decimalDot')}</SelectItem>
                            <SelectItem value="decimal-comma">{csvT('decimalComma')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="flex flex-col gap-2 mt-2">
                <div className="flex items-center space-x-2">
                    <Checkbox
                        id="includeHeaders"
                        checked={options.includeHeaders}
                        onCheckedChange={(checked) => setOptions({ ...options, includeHeaders: checked as boolean })}
                    />
                    <Label htmlFor="includeHeaders">{csvT('headers')}</Label>
                </div>
                <div className="flex items-center space-x-2">
                    <Checkbox
                        id="includeRowNumbers"
                        checked={options.includeRowNumbers}
                        onCheckedChange={(checked) => setOptions({ ...options, includeRowNumbers: checked as boolean })}
                    />
                    <Label htmlFor="includeRowNumbers">{csvT('rowNumbers')}</Label>
                </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2 mt-4">
                <Button variant="outline" onClick={onClose}>{t('export.cancel')}</Button>
                <Button onClick={handleConfirm}>{t('export.action')}</Button>
            </div>
        </div>
    );
};
