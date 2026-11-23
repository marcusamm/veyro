// Shared by both AJ browser bundles, including forms rendered after the page loads.
export const formValidation = String.raw`
(() => {
    const messages = new WeakMap();
    let nextId = 0;
    let focusTimer;

    function errorText(field) {
        const v = field.validity;
        if (v.badInput) return field.type === 'number' ? 'Skriv et tal.' : 'Tjek, at værdien er skrevet korrekt.';
        if (v.valueMissing) {
            if (field.name === 'name') {
                if (field.form.matches('[data-service-form]')) return 'Skriv ydelsens navn.';
                if (field.form.matches('[data-staff-form]')) return 'Skriv medarbejderens navn.';
                return 'Skriv dit navn.';
            }
            if (field.type === 'email') return 'Skriv din e-mailadresse.';
            if (field.type === 'tel') return 'Skriv dit telefonnummer.';
            if (field.type === 'file') return 'Vælg et billede.';
            if (field.type === 'date') return 'Vælg en dato.';
            if (field.type === 'time') return 'Vælg et tidspunkt.';
            if (field.type === 'datetime-local') return 'Vælg dato og tidspunkt.';
            if (field.name === 'message') return 'Skriv din besked.';
            if (field.name === 'title') return 'Skriv bilens mærke og model.';
            if (field.name === 'priceDkk') return 'Skriv bilens pris.';
            if (field.tagName === 'SELECT') return 'Vælg en mulighed.';
            return 'Udfyld feltet.';
        }
        if (v.typeMismatch && field.type === 'email') return 'Skriv en gyldig e-mailadresse.';
        if (v.tooShort) return 'Skriv mindst ' + field.minLength + ' tegn.';
        if (v.tooLong) return 'Skriv højst ' + field.maxLength + ' tegn.';
        if (field.type === 'number') {
            if (v.rangeUnderflow) return 'Vælg ' + field.min + ' eller mere.';
            if (v.rangeOverflow) return 'Vælg ' + field.max + ' eller mindre.';
            if (v.stepMismatch && field.step === '1') return 'Skriv et helt tal.';
            if (v.stepMismatch && field.step) return 'Brug intervaller på ' + field.step + '.';
        }
        return 'Tjek, at værdien er skrevet korrekt.';
    }

    function show(field) {
        let message = messages.get(field);
        if (!message) {
            message = document.createElement('span');
            message.id = 'aj-field-error-' + (++nextId);
            message.className = 'field-error';
            // Keep the error out of the wrapping label's name. aria-describedby
            // exposes it separately as the field's accessible description.
            message.setAttribute('aria-hidden', 'true');
            field.after(message);
            messages.set(field, message);
            const previous = field.getAttribute('aria-describedby') || '';
            field.setAttribute('aria-describedby', (previous + ' ' + message.id).trim());
        }
        field.setAttribute('aria-invalid', 'true');
        message.textContent = errorText(field);
    }

    function update(event) {
        const field = event.target;
        const message = messages.get(field);
        if (!message) return;
        if (!field.validity.valid) {
            message.textContent = errorText(field);
            return;
        }
        const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== message.id);
        if (ids.length) field.setAttribute('aria-describedby', ids.join(' '));
        else field.removeAttribute('aria-describedby');
        field.removeAttribute('aria-invalid');
        message.remove();
        messages.delete(field);
    }

    document.addEventListener('invalid', event => {
        const field = event.target;
        if (!field.form || !field.willValidate) return;
        event.preventDefault();
        show(field);
        const form = field.form;
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => {
            if (form.isConnected) {
                Array.from(form.elements).find(control => control.willValidate && !control.validity.valid)?.focus();
            }
        }, 0);
    }, true);
    document.addEventListener('input', update);
    document.addEventListener('change', update);
})();
`;
