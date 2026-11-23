// Included in the authenticated workshop workspace with its existing request and form helpers.
export const carAdminJs = String.raw`
    const carStatuses = { draft: 'Kladde', published: 'Til salg', sold: 'Solgt' };
    const carPrice = value => new Intl.NumberFormat('da-DK').format(value) + ' kr.';

    function renderCars(el) {
        el.innerHTML = head('Biler til salg') + '<div id="adm-cars"><p>Henter bilerne…</p></div>';
        const container = $('#adm-cars', el);
        function mutate(action) {
            if (container.getAttribute('aria-busy') !== 'true') return busy(container, action);
        }
        async function load(selectedId) {
            const result = await api('cars');
            if (!container.isConnected) return;
            if (selectedId) {
                const car = result.cars.find(item => item.id === selectedId);
                if (!car) throw new Error('Annoncen findes ikke længere.');
                edit(car);
            } else {
                showList(result.cars);
            }
        }
        function showList(cars) {
            container.innerHTML = '<div class="adm-actions"><button class="adm-button" id="adm-car-new">Opret bil</button><a href="/biler-til-salg">Se biler på hjemmesiden</a></div>' +
                (cars.length ? '<ul class="adm-cars-list">' + cars.map(car =>
                    '<li><div><strong>' + esc(car.title) + '</strong><p class="adm-hint">' + carPrice(car.priceDkk) + ' · ' + esc(carStatuses[car.status]) +
                    '</p></div><button type="button" class="adm-button adm-secondary adm-small" data-car-edit="' + esc(car.id) +
                    '" aria-label="Rediger ' + esc(car.title) + '">Rediger</button></li>').join('') + '</ul>' : empty('Du har endnu ingen bilannoncer.'));
            $('#adm-car-new', container).onclick = () => { message(''); edit(null); };
            container.querySelectorAll('[data-car-edit]').forEach(button => {
                button.onclick = () => { message(''); edit(cars.find(car => car.id === Number(button.dataset.carEdit))); };
            });
        }
        function edit(car, pending = []) {
            const savedPhotos = car?.photos ?? [];
            const picker = '<div class="adm-car-picker"><label>Billeder af bilen<span class="adm-photo-select"><span>Vælg billeder</span><input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple aria-describedby="adm-photo-help"></span></label>' +
                '<p id="adm-photo-help" class="adm-hint">Vælg op til otte billeder. Det første vises i oversigten. JPG, PNG og WebP.</p><ul class="adm-car-photos" id="adm-car-preview"></ul></div>';
            const value = field => esc(car?.[field] ?? '');
            const requestId = crypto.randomUUID();
            const status = car ? '<label>Status<select name="status">' + Object.entries(carStatuses).map(([key,label]) =>
                '<option value="' + key + '"' + (car.status === key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>' : '';
            container.innerHTML = '<div class="adm-actions"><button id="adm-cars-back" class="adm-button adm-secondary adm-small" type="button">Til oversigten</button></div>' +
                '<form id="adm-car-form" class="adm-form adm-card adm-gap20"><h3>' + (car ? 'Rediger annonce' : 'Opret bil') + '</h3><div class="adm-form-grid">' +
                '<label class="adm-full">Mærke og model<input required name="title" maxlength="120" placeholder="Fx VW Golf 1.4 TSI" value="' + value('title') + '"></label>' +
                '<label>Pris i kr.<input required type="number" min="1" max="999999999" step="1" name="priceDkk" value="' + value('priceDkk') + '"></label>' +
                '<label>Årgang<input type="number" min="1886" max="' + (new Date().getFullYear()+1) + '" name="modelYear" value="' + value('modelYear') + '"></label>' +
                '<label>Kilometertal<input type="number" min="0" max="9999999" name="mileageKm" value="' + value('mileageKm') + '"></label>' +
                '<label>Drivmiddel<input name="fuel" maxlength="60" placeholder="Fx benzin eller el" value="' + value('fuel') + '"></label>' +
                '<label>Gearkasse<input name="transmission" maxlength="60" placeholder="Fx automatgear" value="' + value('transmission') + '"></label>' + status +
                '<label class="adm-full">Beskrivelse<textarea name="description" maxlength="4000" rows="5">' + value('description') + '</textarea></label></div>' +
                (car ? '<p class="adm-hint">Vælg ”Til salg” for at vise annoncen på hjemmesiden. En solgt bil fjernes fra den offentlige oversigt.</p>' :
                  picker) +
                '<div class="adm-actions"><button class="adm-button" type="submit">' + (car ? 'Gem ændringer' : 'Gem kladde') + '</button></div></form>' +
                (car ? '<section class="adm-card" id="adm-car-photo-panel"><h3>Billeder</h3><div id="adm-car-thumbs"></div>' +
                '<form id="adm-car-images" class="adm-form">' + picker +
                '<div class="adm-actions"><button type="submit" class="adm-button adm-secondary">Tilføj billeder</button></div></form></section>' : '');
            $('#adm-cars-back', container).onclick = () => mutate(() => load());
            const form = $('#adm-car-form', container);
            const photoInput = container.querySelector('input[name="photos"]');
            const previews = $('#adm-car-preview', container);
            function showSelection() {
                previews.innerHTML = pending.map((photo, index) => '<li><img src="data:image/jpeg;base64,' + photo.data +
                    '" alt="' + esc(photo.name) + '"><button type="button" class="adm-button adm-secondary adm-small" data-unselect="' + index +
                    '" aria-label="Fravælg ' + esc(photo.name) + '">Fravælg</button></li>').join('');
                previews.querySelectorAll('[data-unselect]').forEach(button => {
                    button.onclick = () => { pending.splice(Number(button.dataset.unselect), 1); showSelection(); };
                });
                photoInput.disabled = savedPhotos.length + pending.length >= 8;
            }
            photoInput.onchange = () => mutate(async () => {
                const files = Array.from(photoInput.files);
                photoInput.value = '';
                const remaining = 8 - savedPhotos.length - pending.length;
                if (files.length > remaining) throw new Error('Der er plads til ' + remaining + ' billeder mere.');
                photoInput.disabled = true;
                try {
                    for (const file of files) {
                        const data = await prepareCarPhoto(file);
                        if (!pending.some(photo => photo.data === data)) pending.push({ name: file.name, data });
                    }
                } finally { showSelection(); }
            });
            async function uploadPending(carId) {
                photoInput.disabled = true;
                try {
                    while (pending.length) {
                        const result = await api('cars/' + carId + '/photos', 'POST', { data: pending[0].data });
                        if (!savedPhotos.includes(result.id)) savedPhotos.push(result.id);
                        pending.shift();
                    }
                } finally { showSelection(); }
            }
            function showSaved() {
                const thumbs = $('#adm-car-thumbs', container);
                thumbs.innerHTML = '<ul class="adm-car-photos">' + savedPhotos.map((photo, index) =>
                    '<li><img alt="Billede ' + (index+1) + ' af ' + esc(car.title) + '" src="/api/admin/cars/' + car.id + '/photos/' + photo + '" loading="lazy">' +
                    '<button class="adm-button adm-secondary adm-small" type="button" data-remove-photo="' + photo +
                    '" aria-label="Fjern billede ' + (index+1) + '">Fjern billede</button></li>').join('') + '</ul>';
                thumbs.querySelectorAll('[data-remove-photo]').forEach(button => {
                    button.onclick = () => {
                        if (!confirm('Fjern dette billede fra annoncen?')) return;
                        mutate(async () => {
                            const id = Number(button.dataset.removePhoto);
                            await api('cars/' + car.id + '/photos/' + id + '/remove', 'POST', {});
                            savedPhotos.splice(savedPhotos.indexOf(id), 1);
                            showSaved();
                            showSelection();
                            message('Billedet er fjernet.');
                        });
                    };
                });
                $('#adm-car-images', container).hidden = savedPhotos.length >= 8;
            }
            if (car) {
                showSaved();
                $('#adm-car-images', container).onsubmit = event => {
                    event.preventDefault();
                    mutate(async () => {
                        if (!pending.length) { photoInput.focus(); throw new Error('Vælg et billede af bilen.'); }
                        try { await uploadPending(car.id); }
                        finally { showSaved(); }
                        message('Billederne er gemt.');
                    });
                };
            }
            showSelection();
            form.onsubmit = event => {
                event.preventDefault();
                mutate(async () => {
                    const fields = Object.fromEntries(new FormData(form));
                    delete fields.photos;
                    fields.priceDkk = Number(fields.priceDkk);
                    fields.modelYear = fields.modelYear ? Number(fields.modelYear) : null;
                    fields.mileageKm = fields.mileageKm ? Number(fields.mileageKm) : null;
                    if (car) {
                        try { await uploadPending(car.id); }
                        finally { showSaved(); }
                        const updated = await api('cars', 'POST', { ...fields, id: car.id, version: car.version });
                        await load(updated.id);
                        if (container.isConnected) message('Annoncen er opdateret.');
                        return;
                    }
                    const draft = await api('cars', 'POST', { ...fields, status: 'draft', requestId });
                    try {
                        await uploadPending(draft.id);
                    } catch (error) {
                        error.message = 'Kladden er gemt. ' + error.message + ' Prøv ”Tilføj billeder” igen.';
                        throw error;
                    } finally {
                        if (container.isConnected) edit({ ...fields, ...draft, status: 'draft', photos: savedPhotos }, pending);
                    }
                    if (container.isConnected) message('Kladden er gemt.');
                });
            };
            form.elements.title.focus();
        }
        busy(container, () => load());
    }

    async function prepareCarPhoto(file) {
        if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Vælg et JPG-, PNG- eller WebP-billede.');
        let image;
        try { image = await createImageBitmap(file); }
        catch { throw new Error('Billedet kunne ikke åbnes. Prøv med et andet foto.'); }
        try {
            const canvas = document.createElement('canvas');
            for (const size of [1600,1280,960,640]) {
                const scale = Math.min(1, size / Math.max(image.width, image.height));
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('Billedet kunne ikke behandles i denne browser.');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                const data = canvas.toDataURL('image/jpeg', .82).split(',')[1];
                if (data && data.length <= 655360) return data;
            }
            throw new Error('Billedet er for stort. Prøv en mindre udgave.');
        } finally { image.close(); }
    }
`;

export const carAdminCss = `
.adm-cars-list, .adm-car-photos { list-style:none; margin:20px 0; padding:0; }
.adm-cars-list li { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
.adm-car-photos { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,130px),1fr)); gap:16px; }
.adm-car-photos:empty { display:none; }
.adm-car-picker { display:grid; gap:6px; }
.adm-car-picker label { display:grid; justify-items:start; gap:8px; }
.adm-photo-select { position:relative; display:inline-flex; align-items:center; min-height:44px; padding:8px 16px; border:1px solid var(--line); border-radius:5px; color:var(--ink); background:white; font-weight:600; }
.adm-photo-select:focus-within { outline:3px solid var(--violet); outline-offset:3px; }
.adm-photo-select:has(input:disabled) { opacity:.6; }
.adm-photo-select input[type=file] { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; }
.adm-car-photos li { display:grid; gap:6px; }
.adm-car-photos img { width:100%; aspect-ratio:4/3; object-fit:cover; }
`;
